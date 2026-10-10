import { describe, expect, it } from "vitest";
import { capture, rpcClient, unwrap } from "./rpc";

class Coded extends Error {
	name = "Coded";
	constructor(readonly code: number) {
		super(`code ${code}`);
	}
}

describe("capture and unwrap", () => {
	it("passes a value through", async () => {
		expect(unwrap(await capture(() => 42))).toBe(42);
		expect(unwrap(await capture(async () => ({ a: 1 })))).toEqual({ a: 1 });
	});

	it("captures an error with its name, message and own fields", async () => {
		expect(await capture(() => { throw new Coded(7); })).toEqual({ ok: false, error: { name: "Coded", message: "code 7", data: { name: "Coded", code: 7 } } });
		expect(await capture(async () => { throw "plain"; })).toEqual({ ok: false, error: { name: "Error", message: "plain", data: {} } });
	});

	it("re-throws a plain error carrying the same fields when nothing revives it", async () => {
		const result = await capture(() => { throw new Coded(7); });
		const error = (() => { try { unwrap(result); } catch (e) { return e; } })();
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({ name: "Coded", message: "code 7", code: 7 });
	});

	it("lets a reviver rebuild the original class", async () => {
		const result = await capture(() => { throw new Coded(7); });
		expect(() => unwrap(result, (error) => (error.name === "Coded" ? new Coded(error.data.code as number) : undefined))).toThrow(Coded);
	});
});

describe("rpcClient", () => {
	interface Api { add(a: number, b: number): Promise<number>; fail(): Promise<never> }
	const target = {
		calls: [] as [string, unknown[]][],
		async rpc(method: string, args: unknown[]) {
			this.calls.push([method, args]);
			return capture(() => {
				if (method === "add") {
					return (args[0] as number) + (args[1] as number);
				}
				throw new Coded(3);
			});
		},
	};

	it("turns method calls into rpc(method, args) and unwraps the result", async () => {
		const client = rpcClient<Api>(target, ["add", "fail"]);
		expect(await client.add(2, 3)).toBe(5);
		await expect(client.fail()).rejects.toMatchObject({ name: "Coded", code: 3 });
		expect(target.calls).toEqual([["add", [2, 3]], ["fail", []]]);
	});

	it("only has the listed methods, so it is not mistaken for a promise", () => {
		const client = rpcClient<Api>(target, ["add"]) as unknown as Record<string, unknown>;
		expect(Object.keys(client)).toEqual(["add"]);
		expect(client.then).toBeUndefined();
	});
});
