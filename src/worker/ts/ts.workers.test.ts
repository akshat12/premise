import { describe, expect, it } from "vitest";
import ts from "./index";

describe("the TypeScript compiler wrapper", () => {
	it("loads the compiler without its Node system object", () => {
		expect(ts.version).toMatch(/^5\./);
		// `sys` is the compiler's handle on the real filesystem. We never want it: every program uses an in-memory host.
		expect(ts.sys).toBeUndefined();
	});

	it("leaves process.browser as it found it", () => {
		const proc = (globalThis as { process?: { browser?: boolean } }).process;
		expect(proc?.browser).toBeUndefined();
	});

	it("can parse and transpile", () => {
		const out = ts.transpileModule("export const a: number = 1;", { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
		expect(out.outputText).toContain("export const a = 1;");
	});
});
