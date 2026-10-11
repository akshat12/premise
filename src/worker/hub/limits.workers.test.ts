import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_SOCKETS, RETRY_AFTER_S } from "./limits";
import { hub as hubFor } from "./publish";

const open = (stub: ReturnType<typeof hubFor>) => stub.fetch("http://hub/api/events/ws", { headers: { Upgrade: "websocket" } });

describe("EventHub WebSocket limit", () => {
	it(`refuses a socket beyond ${MAX_SOCKETS} with a 503, and takes one again when a viewer leaves`, async () => {
		// Its own hub, so the sockets other tests open are not counted.
		const hub = hubFor(env, `limit-${Date.now()}`);
		const sockets: WebSocket[] = [];
		for (let index = 0; index < MAX_SOCKETS; index++) {
			const response = await open(hub);
			expect(response.status).toBe(101);
			const socket = response.webSocket as WebSocket;
			socket.accept();
			sockets.push(socket);
		}

		const refused = await open(hub);
		expect(refused.status).toBe(503);
		expect(refused.headers.get("Retry-After")).toBe(String(RETRY_AFTER_S));
		expect(refused.webSocket ?? null).toBeNull();
		expect(await refused.text()).toContain(`${MAX_SOCKETS} viewers`);

		// Events still reach the sockets that are open, and the log can still be read.
		const received = new Promise<string>((resolve) => sockets[0]?.addEventListener("message", (event) => typeof event.data === "string" && event.data.includes("still here") && resolve(event.data)));
		await hub.publish({ t: "demo.marker", label: "still here" });
		expect(await received).toContain("still here");
		expect(await hub.since(0)).toHaveLength(1);

		// One viewer leaves; once the hub has seen the close, the next one gets in.
		sockets.pop()?.close(1000, "done");
		let status = 503;
		for (let attempt = 0; attempt < 50 && status !== 101; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			const response = await open(hub);
			status = response.status;
			if (response.webSocket) {
				response.webSocket.accept();
				sockets.push(response.webSocket);
			} else {
				await response.text();
			}
		}
		expect(status).toBe(101);
		for (const socket of sockets) {
			socket.close(1000, "done");
		}
	});
});
