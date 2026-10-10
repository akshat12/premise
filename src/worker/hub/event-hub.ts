import { DurableObject } from "cloudflare:workers";
import type { PremiseEvent, PremiseEventBody } from "../../shared/events";
import { moduleShard } from "../../shared/ids";
import type { IntentKind, IntentStatus, Metrics } from "../../shared/types";
import { parseSince, PING, PONG } from "../../shared/wire";
import { computeMetrics, countEvent, type Counters, emptyCounters, type RegistryRow } from "../metrics";

const BACKLOG_PAGE = 2000;

interface EventRow extends Record<string, SqlStorageValue> {
	seq: number;
	ts: number;
	body: string;
}

function toEvent(row: EventRow): PremiseEvent {
	return { ...(JSON.parse(row.body) as PremiseEventBody), seq: row.seq, ts: row.ts };
}

/**
 * The one event log. Every part of the backend publishes here; browsers subscribe over a
 * hibernatable WebSocket. Use the single instance `env.HUB.idFromName("main")` (see publish.ts).
 */
export class EventHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, body TEXT)");
			// Kept up to date as events pass through, so nothing has to scan Durable Objects to list Intents.
			sql.exec("CREATE TABLE IF NOT EXISTS registry(id TEXT PRIMARY KEY, kind TEXT, task_id TEXT, status TEXT, updated_at INTEGER)");
			sql.exec("CREATE TABLE IF NOT EXISTS shards(name TEXT PRIMARY KEY)");
			sql.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
			// Workflow instances that are paused until something happens: `topic` says what they wait for.
			sql.exec("CREATE TABLE IF NOT EXISTS waiters(instance_id TEXT, topic TEXT, PRIMARY KEY (instance_id, topic))");
		});
		// Answers keep-alive pings without waking a hibernated object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	private getMeta<T>(key: string, fallback: T): T {
		const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
		return row === undefined ? fallback : (JSON.parse(row.value) as T);
	}

	private setMeta(key: string, value: unknown): void {
		this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
	}

	/** Updates the registry, the list of ledger shards in use, and the counters from one event. */
	private index(body: PremiseEventBody, ts: number): void {
		const sql = this.ctx.storage.sql;
		if (body.t === "intent.created") {
			const { id, kind, taskId, status } = body.intent;
			sql.exec("INSERT INTO registry (id, kind, task_id, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at", id, kind, taskId, status, ts);
		} else if (body.t === "intent.status") {
			sql.exec("UPDATE registry SET status = ?, updated_at = ? WHERE id = ?", body.status, ts, body.id);
		}
		const symbols = body.t === "claim.decision" ? body.symbols : body.t === "premise.recorded" ? [body.premise.symbol] : [];
		for (const shard of new Set(symbols.map(moduleShard))) {
			sql.exec("INSERT OR IGNORE INTO shards (name) VALUES (?)", shard);
		}
		const before = this.getMeta<Counters>("counters", emptyCounters());
		const after = countEvent(before, body);
		if (after !== before) {
			this.setMeta("counters", after);
		}
	}

	private insert(body: PremiseEventBody): PremiseEvent {
		const ts = Date.now();
		this.index(body, ts);
		const row = this.ctx.storage.sql
			.exec<{ seq: number }>("INSERT INTO events (ts, body) VALUES (?, ?) RETURNING seq", ts, JSON.stringify(body))
			.one();
		return { ...body, seq: row.seq, ts };
	}

	private broadcast(message: string): void {
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch {
				// A socket that is closing must not stop the others from getting the event.
			}
		}
	}

	async publish(body: PremiseEventBody): Promise<PremiseEvent> {
		const event = this.insert(body);
		this.broadcast(JSON.stringify(event));
		return event;
	}

	async publishMany(bodies: PremiseEventBody[]): Promise<PremiseEvent[]> {
		const events = bodies.map((body) => this.insert(body));
		for (const event of events) {
			this.broadcast(JSON.stringify(event));
		}
		return events;
	}

	async since(seq: number, limit = 5000): Promise<PremiseEvent[]> {
		return this.ctx.storage.sql
			.exec<EventRow>("SELECT seq, ts, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?", seq, limit)
			.toArray()
			.map(toEvent);
	}

	/**
	 * Clears the log, the registry, the counters and the waiters, and restarts `seq` at 1.
	 * Connected clients are told to drop what they have. The current trunk name is kept.
	 */
	async reset(): Promise<void> {
		const sql = this.ctx.storage.sql;
		sql.exec("DELETE FROM events");
		sql.exec("DELETE FROM sqlite_sequence WHERE name = 'events'");
		sql.exec("DELETE FROM registry");
		sql.exec("DELETE FROM shards");
		sql.exec("DELETE FROM waiters");
		sql.exec("DELETE FROM meta WHERE key != 'trunk'");
		this.broadcast(JSON.stringify({ reset: true }));
	}

	/** Every Intent that has been created, with its latest status. */
	async registry(): Promise<RegistryRow[]> {
		return this.ctx.storage.sql
			.exec<{ id: string; kind: string; task_id: string; status: string; updated_at: number }>("SELECT id, kind, task_id, status, updated_at FROM registry ORDER BY rowid")
			.toArray()
			.map((row) => ({ id: row.id, kind: row.kind as IntentKind, taskId: row.task_id, status: row.status as IntentStatus, updatedAt: row.updated_at }));
	}

	/** Names of the ledger shards that hold, or have held, claims or readers. */
	async shards(): Promise<string[]> {
		return this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM shards ORDER BY name").toArray().map((row) => row.name);
	}

	async metrics(): Promise<Metrics> {
		return computeMetrics(this.getMeta<Counters>("counters", emptyCounters()), await this.registry());
	}

	/** Adds to a counter that no event carries, such as a broken build found by the A/B harness. */
	async bump(counter: "brokenBuildsOnTrunk" | "behaviouralRegressionsOnTrunk" | "humanMerges", by = 1): Promise<void> {
		const counters = this.getMeta<Counters>("counters", emptyCounters());
		this.setMeta("counters", { ...counters, [counter]: counters[counter] + by });
	}

	/** The repo currently acting as trunk, or null if it has never been changed from the default. */
	async trunk(): Promise<string | null> {
		return this.getMeta<string | null>("trunk", null);
	}

	async setTrunk(name: string): Promise<void> {
		this.setMeta("trunk", name);
	}

	/** Notes that a Workflow instance is paused until `topic` happens. */
	async addWaiter(instanceId: string, topic: string): Promise<void> {
		this.ctx.storage.sql.exec("INSERT OR IGNORE INTO waiters (instance_id, topic) VALUES (?, ?)", instanceId, topic);
	}

	/** Returns the instances waiting on `topic` and forgets them: each is woken once. */
	async takeWaiters(topic: string): Promise<string[]> {
		const rows = this.ctx.storage.sql.exec<{ instance_id: string }>("SELECT instance_id FROM waiters WHERE topic = ? ORDER BY rowid", topic).toArray();
		this.ctx.storage.sql.exec("DELETE FROM waiters WHERE topic = ?", topic);
		return rows.map((row) => row.instance_id);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);

		// Send everything after `since`, in pages. There is no await between accepting the socket and
		// finishing the backlog, so no live event can slip in between or arrive out of order.
		let cursor = parseSince(new URL(request.url));
		for (;;) {
			const page = this.ctx.storage.sql
				.exec<EventRow>("SELECT seq, ts, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?", cursor, BACKLOG_PAGE)
				.toArray()
				.map(toEvent);
			server.send(JSON.stringify({ backlog: page }));
			const last = page.at(-1);
			if (page.length < BACKLOG_PAGE || last === undefined) {
				break;
			}
			cursor = last.seq;
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		// Pings are normally answered by the auto-response above; this covers the case where they are not.
		if (message === PING) {
			ws.send(PONG);
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}
}
