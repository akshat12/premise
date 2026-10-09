import { DurableObject } from "cloudflare:workers";
import type { PremiseEvent, PremiseEventBody } from "../../shared/events";
import { parseSince, PING, PONG } from "../../shared/wire";

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
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, body TEXT)");
		});
		// Answers keep-alive pings without waking a hibernated object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	private insert(body: PremiseEventBody): PremiseEvent {
		const ts = Date.now();
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

	/** Clears the log and restarts `seq` at 1. Connected clients are told to drop what they have. */
	async reset(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM events");
		this.ctx.storage.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'events'");
		this.broadcast(JSON.stringify({ reset: true }));
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
