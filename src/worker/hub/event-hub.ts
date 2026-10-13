import { DurableObject } from "cloudflare:workers";
import type { PremiseEvent, PremiseEventBody } from "../../shared/events";
import { moduleShard } from "../../shared/ids";
import type { IntentKind, IntentStatus, Metrics } from "../../shared/types";
import { parseSince, PING, PONG } from "../../shared/wire";
import { computeMetrics, countEvent, type Counters, emptyCounters, type RegistryRow } from "../metrics";
import { AT_REST, type BoardFacts, claimPublicRun, clearPublicRuns, failPublicRun, isScripted, newPublicRunState, type PublicRunState, type PublicRunStatus, publicRunStatus, refusePublicRun } from "../live/public-run";
import type { RecentRuns, RunSummary } from "../../shared/runs";
import { type Landing, landingOf, RUN_EVENTS_KEPT, RUNS_KEPT, summariseRun } from "../live/runs";
import { atCapacity, capacityMessage, RETRY_AFTER_S } from "./limits";

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
			// Trunk commits whose effect on in-flight Intents has been worked out. A commit can be reported twice.
			sql.exec("CREATE TABLE IF NOT EXISTS processed_commits(commit_sha TEXT PRIMARY KEY, ts INTEGER)");
			// Intents that have recorded at least one asserted premise: the only ones invalidation has to open.
			sql.exec("CREATE TABLE IF NOT EXISTS asserters(id TEXT PRIMARY KEY)");
			// Past runs, one line each (shared/runs.ts): written when the board is cleared, and kept across resets.
			sql.exec("CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT)");
			// The events of each kept run, so that it can be played again as the Demo tab plays a recording.
			sql.exec("CREATE TABLE IF NOT EXISTS run_events(run_id INTEGER, seq INTEGER, ts INTEGER, body TEXT, PRIMARY KEY (run_id, seq))");
			// What a real model answered, turn by turn, so a live run can be saved and replayed as a script.
			sql.exec("CREATE TABLE IF NOT EXISTS llm_turns(script TEXT, idx INTEGER, turn TEXT, PRIMARY KEY (script, idx))");
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
		if (body.t === "premise.recorded" && body.premise.source === "asserted") {
			sql.exec("INSERT OR IGNORE INTO asserters (id) VALUES (?)", body.id);
		}
		const symbols = body.t === "claim.decision" ? body.symbols : body.t === "premise.recorded" ? [body.premise.symbol] : [];
		// A symbol id that does not parse is not worth losing the event over: it names no shard.
		const shardOf = (symbol: string): string[] => {
			try {
				return [moduleShard(symbol)];
			} catch {
				return [];
			}
		};
		for (const shard of new Set(symbols.flatMap(shardOf))) {
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

	/**
	 * True for an event about an Intent this log has never seen created. After a reset, agents and gate
	 * passes of the run before can still be finishing; what they say belongs to a log that is gone.
	 */
	private fromBefore(body: PremiseEventBody): boolean {
		if (body.t === "intent.created") {
			return false;
		}
		// The Intent an event is about, wherever the event names it. A fork's own events name none, and are kept.
		const detail = body.t === "artifacts" ? body.detail?.intent : undefined;
		const id = "id" in body ? body.id : body.t === "gate.result" ? body.report.intentId : body.t === "trunk.advanced" ? body.byIntent : typeof detail === "string" ? detail : null;
		if (typeof id !== "string") {
			return false;
		}
		return this.ctx.storage.sql.exec("SELECT 1 FROM registry WHERE id = ?", id).toArray().length === 0;
	}

	async publish(body: PremiseEventBody): Promise<PremiseEvent> {
		if (this.fromBefore(body)) {
			// Not kept and not sent. The caller still gets an event back; `seq` 0 says it is in no log.
			return { ...body, seq: 0, ts: Date.now() };
		}
		const event = this.insert(body);
		this.broadcast(JSON.stringify(event));
		return event;
	}

	async publishMany(bodies: PremiseEventBody[]): Promise<PremiseEvent[]> {
		const events = bodies.filter((body) => !this.fromBefore(body)).map((body) => this.insert(body));
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
	 * Connected clients are told to drop what they have. The current trunk name is kept, and so are
	 * the model choice and the public run's record (its switch and its starts are not part of a run).
	 */
	async reset(asked = true, origin: RunSummary["origin"] = "owner", leavingTrunk?: string): Promise<void> {
		const sql = this.ctx.storage.sql;
		// The run that is about to be cleared is kept as one line. (Not a comparison run: the other two
		// rules are not Premise, and their results belong in the comparison, not in a list of its runs.)
		// Its trunk is named in the line. A caller that has already pointed the hub at a fresh trunk says
		// which repo the run was on; otherwise it is the one still in use.
		const leaving = this.getMeta<string>("mode", "premise") === "premise" ? this.runOnBoard(0, leavingTrunk ?? this.getMeta<string | null>("trunk", null)) : null;
		if (leaving !== null) {
			const kept = sql.exec<{ id: number }>("INSERT INTO runs (summary) VALUES (?) RETURNING id", JSON.stringify(leaving)).one();
			// Its log goes with it, copied inside the database, unless it is too long to keep thirty of.
			const count = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
			const events = count <= RUN_EVENTS_KEPT ? count : 0;
			if (events > 0) {
				sql.exec("INSERT INTO run_events (run_id, seq, ts, body) SELECT ?, seq, ts, body FROM events", kept.id);
			}
			sql.exec("UPDATE runs SET summary = ? WHERE id = ?", JSON.stringify({ ...leaving, id: kept.id, events }), kept.id);
			sql.exec("DELETE FROM runs WHERE id <= ?", kept.id - RUNS_KEPT);
			sql.exec("DELETE FROM run_events WHERE run_id <= ?", kept.id - RUNS_KEPT);
		}
		sql.exec("DELETE FROM events");
		sql.exec("DELETE FROM sqlite_sequence WHERE name = 'events'");
		sql.exec("DELETE FROM registry");
		sql.exec("DELETE FROM shards");
		sql.exec("DELETE FROM waiters");
		sql.exec("DELETE FROM processed_commits");
		sql.exec("DELETE FROM asserters");
		sql.exec("DELETE FROM llm_turns");
		sql.exec("DELETE FROM meta WHERE key NOT IN ('trunk', 'llm', 'public_runs')");
		// A reset somebody asked for is about to be followed by a run, and says when it happened so that a
		// public start does not land on top of it. One that nobody asked for (see recoverMemoryStore) does not.
		if (asked) {
			this.setMeta("reset_at", Date.now());
		}
		// Who is starting the run that follows, for its own line later.
		this.setMeta("run_origin", origin);
		this.broadcast(JSON.stringify({ reset: true }));
	}

	/** Every Intent that has been created, with its latest status. */
	async registry(): Promise<RegistryRow[]> {
		return this.ctx.storage.sql
			.exec<{ id: string; kind: string; task_id: string; status: string; updated_at: number }>("SELECT id, kind, task_id, status, updated_at FROM registry ORDER BY rowid")
			.toArray()
			.map((row) => ({ id: row.id, kind: row.kind as IntentKind, taskId: row.task_id, status: row.status as IntentStatus, updatedAt: row.updated_at }));
	}

	/** Whether an Intent with this id has been created since the last reset. Public routes ask before they open an Intent. */
	async knows(id: string): Promise<boolean> {
		return this.ctx.storage.sql.exec("SELECT 1 FROM registry WHERE id = ?", id).toArray().length > 0;
	}

	/** Ids of Intents that have asserted a premise, in the order they first did. */
	async asserters(): Promise<string[]> {
		return this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM asserters ORDER BY rowid").toArray().map((row) => row.id);
	}

	/**
	 * Marks a trunk commit as dealt with. Returns true the first time and false after that, so
	 * whoever gets true does the work and nobody does it twice.
	 */
	async claimCommit(commit: string): Promise<boolean> {
		return this.ctx.storage.sql.exec("INSERT OR IGNORE INTO processed_commits (commit_sha, ts) VALUES (?, ?)", commit, Date.now()).rowsWritten > 0;
	}

	async isProcessed(commit: string): Promise<boolean> {
		return this.ctx.storage.sql.exec("SELECT 1 FROM processed_commits WHERE commit_sha = ?", commit).toArray().length > 0;
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

	/**
	 * How work lands. "premise" is the product. The other two are the comparisons for the A/B
	 * report, and neither has a ledger, premises or re-derive: "baseline" lands a clean textual
	 * rebase that typechecks; "queue" also runs the tests first. A reset puts it back to "premise".
	 */
	async mode(): Promise<"premise" | "baseline" | "queue"> {
		return this.getMeta<"premise" | "baseline" | "queue">("mode", "premise");
	}

	async setMode(mode: "premise" | "baseline" | "queue"): Promise<void> {
		this.setMeta("mode", mode === "baseline" || mode === "queue" ? mode : "premise");
	}

	/**
	 * Which model provider the agents use, when it has been chosen at run time (an admin route sets
	 * it). null means "whatever the Worker is configured with" (the LLM and LLM_MODEL vars). Like
	 * the trunk name, it is configuration and survives a reset.
	 */
	async llm(): Promise<{ provider: string; model?: string } | null> {
		return this.getMeta<{ provider: string; model?: string } | null>("llm", null);
	}

	async setLlm(choice: { provider: string; model?: string } | null): Promise<void> {
		this.setMeta("llm", choice);
	}

	// ---- the record of runs (live/runs.ts) ----

	/** The run on the board now as one line, or null if there are no agents on it. */
	private runOnBoard(id: number, trunk: string | null = null): RunSummary | null {
		const sql = this.ctx.storage.sql;
		const first = sql.exec<{ ts: number }>("SELECT ts FROM events ORDER BY seq LIMIT 1").toArray()[0];
		const last = sql.exec<{ ts: number }>("SELECT ts FROM events ORDER BY seq DESC LIMIT 1").toArray()[0];
		if (first === undefined || last === undefined) {
			return null;
		}
		const registry = sql
			.exec<{ kind: string; status: string }>("SELECT kind, status FROM registry")
			.toArray()
			.map((row) => ({ kind: row.kind as IntentKind, status: row.status as IntentStatus }));
		return summariseRun({
			id,
			origin: this.getMeta<RunSummary["origin"]>("run_origin", "owner"),
			registry,
			counters: this.getMeta<Counters>("counters", emptyCounters()),
			firstTs: first.ts,
			lastTs: last.ts,
			scripted: isScripted(this.getMeta<{ provider: string } | null>("llm", null), this.env.LLM),
			trunk,
		});
	}

	/** The run on the board, and the ones before it, newest first. */
	async runs(): Promise<RecentRuns> {
		const past = this.ctx.storage.sql
			.exec<{ summary: string }>("SELECT summary FROM runs ORDER BY id DESC LIMIT ?", RUNS_KEPT)
			.toArray()
			.map((row) => JSON.parse(row.summary) as RunSummary);
		return { current: this.getMeta<string>("mode", "premise") === "premise" ? this.runOnBoard(0) : null, past };
	}

	/** The events of a kept run, in order, after `seq`. Empty for a run that is not kept, or was kept as a line only. */
	async runEvents(id: number, seq = 0, limit = 5000): Promise<PremiseEvent[]> {
		return this.ctx.storage.sql
			.exec<EventRow>("SELECT seq, ts, body FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?", id, seq, limit)
			.toArray()
			.map(toEvent);
	}

	/**
	 * Removes a kept run from the record: its line and its events. Returns the repo that was its
	 * trunk (null if none was recorded), for the caller to remove if nothing else needs it; null
	 * for a run that is not kept. The run on the board is not a kept run and cannot be removed here.
	 */
	async deleteRun(id: number): Promise<{ trunk: string | null } | null> {
		const sql = this.ctx.storage.sql;
		const run = sql.exec<{ summary: string }>("SELECT summary FROM runs WHERE id = ?", id).toArray()[0];
		if (run === undefined) {
			return null;
		}
		sql.exec("DELETE FROM run_events WHERE run_id = ?", id);
		sql.exec("DELETE FROM runs WHERE id = ?", id);
		return { trunk: (JSON.parse(run.summary) as RunSummary).trunk ?? null };
	}

	/** The repos that were trunk for the runs that are kept. A reset leaves these alone and removes other old copies. */
	async keptTrunks(): Promise<string[]> {
		const kept = this.ctx.storage.sql
			.exec<{ summary: string }>("SELECT summary FROM runs")
			.toArray()
			.flatMap((row) => {
				const trunk = (JSON.parse(row.summary) as RunSummary).trunk;
				return trunk ? [trunk] : [];
			});
		return [...new Set(kept)];
	}

	/**
	 * Where an Intent's work is in a kept run: the run's trunk repo (null if none was recorded for
	 * it), and the Intent's landing there (null if it did not land). null for a run that is not kept.
	 */
	async runLanding(id: number, intentId: string): Promise<{ trunk: string | null; landing: Landing | null } | null> {
		const sql = this.ctx.storage.sql;
		const run = sql.exec<{ summary: string }>("SELECT summary FROM runs WHERE id = ?", id).toArray()[0];
		if (run === undefined) {
			return null;
		}
		const events = sql
			.exec<{ body: string }>("SELECT body FROM run_events WHERE run_id = ? ORDER BY seq", id)
			.toArray()
			.map((row) => JSON.parse(row.body) as PremiseEventBody);
		return { trunk: (JSON.parse(run.summary) as RunSummary).trunk ?? null, landing: landingOf(events, intentId) };
	}

	// ---- the run anyone can start (see live/public-run.ts for the rules) ----

	private publicRuns(): PublicRunState {
		return { ...newPublicRunState(), ...this.getMeta<Partial<PublicRunState>>("public_runs", {}) };
	}

	private board(): BoardFacts {
		const sql = this.ctx.storage.sql;
		const rest = AT_REST.map(() => "?").join(", ");
		const counts = sql.exec<{ intents: number; unsettled: number | null }>(`SELECT COUNT(*) AS intents, SUM(CASE WHEN status NOT IN (${rest}) THEN 1 ELSE 0 END) AS unsettled FROM registry`, ...AT_REST).one();
		// The newest event is the last by `seq`, which is one row to read. (MAX(ts) would read the whole log, and this is asked every few seconds.)
		const last = sql.exec<{ ts: number }>("SELECT ts FROM events ORDER BY seq DESC LIMIT 1").toArray()[0];
		return { intents: counts.intents, unsettled: counts.unsettled ?? 0, lastEventAt: last?.ts ?? 0, resetAt: this.getMeta<number>("reset_at", 0), resetBegunAt: this.getMeta<number>("reset_begun", 0) };
	}

	private publicRunFacts(gateBusy: boolean, now: number) {
		return { ...this.board(), now, gateBusy, scripted: isScripted(this.getMeta<{ provider: string } | null>("llm", null), this.env.LLM) };
	}

	/** Whether a public run may start now. `gateBusy` is the one thing only the gate knows. */
	async publicRun(gateBusy: boolean, now = Date.now()): Promise<PublicRunStatus> {
		return publicRunStatus(this.publicRuns(), this.publicRunFacts(gateBusy, now));
	}

	/**
	 * Takes the next public start, if one is allowed. Deciding and recording happen here, in one
	 * turn of this object, so of two requests that arrive together exactly one is told yes.
	 */
	async claimPublicRun(gateBusy: boolean, now = Date.now()): Promise<{ ok: true; startedAt: number; seed: number } | { ok: false; status: PublicRunStatus }> {
		const claim = claimPublicRun(this.publicRuns(), this.publicRunFacts(gateBusy, now));
		if (!claim.ok) {
			return claim;
		}
		this.setMeta("public_runs", claim.state);
		return { ok: true, startedAt: claim.startedAt, seed: claim.seed };
	}

	/**
	 * Asked by a claimed start just before it resets the board: why it must not go ahead, or null.
	 * A start that is told no is recorded as failed, so nothing waits for it.
	 */
	async confirmPublicRun(startedAt: number, gateBusy: boolean, now = Date.now()): Promise<string | null> {
		const refusal = refusePublicRun(this.publicRuns(), this.publicRunFacts(gateBusy, now), startedAt);
		if (refusal !== null) {
			this.setMeta("public_runs", failPublicRun(this.publicRuns(), startedAt, refusal, now));
		}
		return refusal;
	}

	/** The start made at `startedAt` did not get going. */
	async publicRunFailed(startedAt: number, error: string, now = Date.now()): Promise<void> {
		this.setMeta("public_runs", failPublicRun(this.publicRuns(), startedAt, error, now));
	}

	/**
	 * The switch for public runs. Off refuses every start until it is turned on again. `clear`
	 * also forgets the starts on record, which gives the day's runs back.
	 */
	async setPublicRuns(enabled: boolean, clear = false): Promise<void> {
		const state = { ...this.publicRuns(), enabled };
		this.setMeta("public_runs", clear ? clearPublicRuns(state) : state);
	}

	/**
	 * A reset is about to begin (see `resetDemo`). It takes a while before it reaches `reset()`
	 * here, and until then the board still shows the run before, at rest, which is exactly when a
	 * public start would be allowed. This is how that start is told to wait.
	 */
	async resetBegun(): Promise<void> {
		this.setMeta("reset_begun", Date.now());
	}

	/** The reset that was begun did not finish. Nothing is waiting on it any more. */
	async resetAbandoned(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'reset_begun'");
	}

	/**
	 * Keeps turn number `index` (from 0) of the conversation a real model is having under `script`
	 * ("<taskId>" for a first run, "<taskId>.rederive" for a re-derive). Turn 0 starts the script
	 * again, so a second re-derive replaces the first instead of mixing with it; a retried step
	 * writes the same turn twice.
	 */
	async recordTurn(script: string, index: number, turn: string): Promise<void> {
		const sql = this.ctx.storage.sql;
		if (index === 0) {
			sql.exec("DELETE FROM llm_turns WHERE script = ?", script);
		}
		sql.exec("INSERT INTO llm_turns (script, idx, turn) VALUES (?, ?, ?) ON CONFLICT(script, idx) DO UPDATE SET turn = excluded.turn", script, index, turn);
	}

	/** Every recorded script since the last reset: script key -> its turns in order, in the shape ScriptedLlm replays. */
	async recordedTurns(): Promise<Record<string, unknown[]>> {
		const scripts: Record<string, unknown[]> = {};
		for (const row of this.ctx.storage.sql.exec<{ script: string; turn: string }>("SELECT script, turn FROM llm_turns ORDER BY script, idx")) {
			(scripts[row.script] ??= []).push(JSON.parse(row.turn));
		}
		return scripts;
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
		// Every event goes to every socket, so the number of sockets is bounded (see limits.ts).
		if (atCapacity(this.ctx.getWebSockets().length)) {
			return new Response(capacityMessage(), { status: 503, headers: { "Retry-After": String(RETRY_AFTER_S) } });
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
