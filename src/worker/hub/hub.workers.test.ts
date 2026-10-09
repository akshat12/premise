import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { parseServerMessage, type ServerMessage } from "../../shared/wire";
import { hub as hubFor, type HubApi } from "./publish";

// Each test uses its own hub instance so they cannot see each other's events.
let counter = 0;
function freshHub(): HubApi {
	return hubFor(env, `test-${Date.now()}-${counter++}`);
}

/** Opens a socket to a hub and collects decoded frames. `next()` waits for the following frame. */
async function connect(stub: HubApi, since = 0) {
	const response = await stub.fetch(`http://hub/api/events/ws?since=${since}`, { headers: { Upgrade: "websocket" } });
	expect(response.status).toBe(101);
	const socket = response.webSocket;
	if (!socket) {
		throw new Error("no webSocket on the response");
	}
	const raw: string[] = [];
	const waiters: ((frame: string) => void)[] = [];
	socket.addEventListener("message", (event) => {
		const frame = typeof event.data === "string" ? event.data : "";
		const waiter = waiters.shift();
		if (waiter) {
			waiter(frame);
		} else {
			raw.push(frame);
		}
	});
	socket.accept();
	const nextRaw = () => {
		const queued = raw.shift();
		return queued !== undefined ? Promise.resolve(queued) : new Promise<string>((resolve) => waiters.push(resolve));
	};
	return {
		socket,
		nextRaw,
		next: async (): Promise<ServerMessage | null> => parseServerMessage(await nextRaw()),
	};
}

describe("EventHub RPC", () => {
	it("publish assigns seq 1 and ts, and since() returns it", async () => {
		const hub = freshHub();
		const before = Date.now();
		const event = await hub.publish({ t: "demo.marker", label: "hi" });
		expect(event).toMatchObject({ t: "demo.marker", label: "hi", seq: 1 });
		expect(event.ts).toBeGreaterThanOrEqual(before);
		expect(await hub.since(0)).toEqual([event]);
	});

	it("publishMany keeps order and since() pages by seq and limit", async () => {
		const hub = freshHub();
		const events = await hub.publishMany([
			{ t: "demo.marker", label: "a" },
			{ t: "demo.marker", label: "b" },
			{ t: "demo.marker", label: "c" },
		]);
		expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
		expect((await hub.since(1)).map((event) => event.seq)).toEqual([2, 3]);
		expect((await hub.since(0, 2)).map((event) => event.seq)).toEqual([1, 2]);
		expect(await hub.since(3)).toEqual([]);
	});

	it("round-trips a structured event body", async () => {
		const hub = freshHub();
		const body = {
			t: "trunk.advanced",
			commit: "a".repeat(40),
			byIntent: "i3k9x0a2q",
			changedSymbols: ["src/auth/session.ts#verifySession"],
		} as const;
		await hub.publish({ ...body, changedSymbols: [...body.changedSymbols] });
		const [stored] = await hub.since(0);
		expect(stored).toMatchObject(body);
	});

	it("reset clears the log and restarts seq at 1", async () => {
		const hub = freshHub();
		await hub.publishMany([{ t: "demo.marker", label: "a" }, { t: "demo.marker", label: "b" }]);
		await hub.reset();
		expect(await hub.since(0)).toEqual([]);
		expect((await hub.publish({ t: "demo.marker", label: "c" })).seq).toBe(1);
	});
});

describe("EventHub WebSocket", () => {
	it("sends the backlog, then live events", async () => {
		const hub = freshHub();
		const first = await hub.publish({ t: "demo.marker", label: "before" });
		const client = await connect(hub);

		expect(await client.next()).toEqual({ kind: "backlog", events: [first] });

		const live = await hub.publish({ t: "demo.marker", label: "after" });
		expect(await client.next()).toEqual({ kind: "event", event: live });
		client.socket.close(1000, "done");
	});

	it("resumes after ?since=N", async () => {
		const hub = freshHub();
		const events = await hub.publishMany([
			{ t: "demo.marker", label: "1" },
			{ t: "demo.marker", label: "2" },
			{ t: "demo.marker", label: "3" },
		]);
		const client = await connect(hub, 2);
		expect(await client.next()).toEqual({ kind: "backlog", events: [events[2]] });
		client.socket.close(1000, "done");
	});

	it("sends an empty backlog on a fresh log", async () => {
		const client = await connect(freshHub());
		expect(await client.next()).toEqual({ kind: "backlog", events: [] });
		client.socket.close(1000, "done");
	});

	it("broadcasts to every connected client and tells them about a reset", async () => {
		const hub = freshHub();
		const one = await connect(hub);
		const two = await connect(hub);
		await one.next();
		await two.next();

		const event: PremiseEvent = await hub.publish({ t: "demo.marker", label: "all" });
		expect(await one.next()).toEqual({ kind: "event", event });
		expect(await two.next()).toEqual({ kind: "event", event });

		await hub.reset();
		expect(await one.next()).toEqual({ kind: "reset" });
		expect(await two.next()).toEqual({ kind: "reset" });
		one.socket.close(1000, "done");
		two.socket.close(1000, "done");
	});

	it("answers ping with pong", async () => {
		const client = await connect(freshHub());
		await client.next();
		client.socket.send("ping");
		expect(await client.nextRaw()).toBe("pong");
		client.socket.close(1000, "done");
	});

	it("refuses a plain HTTP request", async () => {
		const response = await freshHub().fetch("http://hub/api/events/ws");
		expect(response.status).toBe(426);
		await response.text();
	});
});

describe("event routes", () => {
	it("GET /api/events returns the log as JSON", async () => {
		const response = await exports.default.fetch("http://premise.test/api/events?since=0");
		expect(response.status).toBe(200);
		expect(Array.isArray(await response.json())).toBe(true);
	});

	it("admin event routes need the admin token", async () => {
		for (const path of ["/api/admin/events/reset", "/api/admin/events/fake"]) {
			const response = await exports.default.fetch(`http://premise.test${path}`, {
				method: "POST",
				body: JSON.stringify({ t: "demo.marker", label: "x" }),
			});
			expect(response.status).toBe(401);
			await response.text();
		}
	});
});
