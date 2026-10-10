import { describe, expect, it } from "vitest";
import { ArtifactsRepoStore, FORK_ATTEMPTS, isArtifactsError, isTransientArtifactsError } from "./artifacts-repo-store";

const ALREADY_EXISTS = { codes: ["ALREADY_EXISTS"], message: /already exists/i };

describe("isArtifactsError", () => {
	it("matches the binding's error by code", () => {
		const error = Object.assign(new Error("whatever"), { name: "ArtifactsError", code: "ALREADY_EXISTS" });
		expect(isArtifactsError(error, ALREADY_EXISTS)).toBe(true);
	});

	it("trusts the code over the message when a code is present", () => {
		const error = Object.assign(new Error("repo already exists"), { code: "NOT_FOUND" });
		expect(isArtifactsError(error, ALREADY_EXISTS)).toBe(false);
	});

	it("falls back to the message for the code-less error the remote binding throws in local dev", () => {
		// Shape observed under `vite dev`: a plain Error, no `code`.
		const error = new Error("ArtifactsError: repo already exists: smoke-e706de2b-0-empty");
		expect(isArtifactsError(error, ALREADY_EXISTS)).toBe(true);
	});

	it("does not match unrelated errors or non-errors", () => {
		expect(isArtifactsError(new Error("network down"), ALREADY_EXISTS)).toBe(false);
		expect(isArtifactsError("already exists", ALREADY_EXISTS)).toBe(false);
		expect(isArtifactsError(null, ALREADY_EXISTS)).toBe(false);
	});
});

describe("fork", () => {
	const HEAD = "a".repeat(40);
	const internal = () => Object.assign(new Error("An internal error occurred."), { name: "ArtifactsError" });

	/** A stand-in for the binding: `fork` on the source repo does whatever `behaviour` says for each call. */
	function fakeArtifacts(behaviour: (call: number) => void) {
		let forkCalls = 0;
		const handle = {
			fork: async () => {
				behaviour(++forkCalls);
				return { name: "fork", remote: "", defaultBranch: "main", token: "" };
			},
			log: async () => [{ hash: HEAD, treeHash: "t" }],
			[Symbol.dispose]: () => undefined,
		};
		const env = { ARTIFACTS: { get: async () => handle } } as unknown as Pick<Env, "ARTIFACTS">;
		return { store: new ArtifactsRepoStore(env, 1), calls: () => forkCalls };
	}

	it("asks again when Artifacts reports an internal error, and succeeds", async () => {
		const fake = fakeArtifacts((call) => {
			if (call < 3) {
				throw internal();
			}
		});
		expect(await fake.store.fork("trunk", "i3k9x0a2q")).toEqual({ head: HEAD });
		expect(fake.calls()).toBe(3);
	});

	it("treats 'already exists' on a later attempt as the earlier attempt having worked", async () => {
		const fake = fakeArtifacts((call) => {
			throw call === 1 ? internal() : Object.assign(new Error("repo already exists"), { code: "ALREADY_EXISTS" });
		});
		expect(await fake.store.fork("trunk", "i3k9x0a2q")).toEqual({ head: HEAD });
		expect(fake.calls()).toBe(2);
	});

	it("waits for a fork that was made but is not visible yet", async () => {
		let gets = 0;
		const handle = { fork: async () => ({}), log: async () => [{ hash: HEAD, treeHash: "t" }], [Symbol.dispose]: () => undefined };
		const env = {
			ARTIFACTS: {
				get: async (name: string) => {
					// The source is there; the new fork takes three looks to appear.
					if (name === "i3k9x0a2q" && ++gets < 3) {
						throw Object.assign(new Error("Repository not found: i3k9x0a2q."), { code: "NOT_FOUND" });
					}
					return handle;
				},
			},
		} as unknown as Pick<Env, "ARTIFACTS">;
		expect(await new ArtifactsRepoStore(env, 1).fork("trunk", "i3k9x0a2q")).toEqual({ head: HEAD });
		expect(gets).toBe(3);
		// A repo nobody just made is simply missing: no waiting.
		await expect(new ArtifactsRepoStore({ ARTIFACTS: { get: async () => Promise.reject(Object.assign(new Error("Repository not found: nope."), { code: "NOT_FOUND" })) } } as unknown as Pick<Env, "ARTIFACTS">, 1).head("nope")).rejects.toThrow("not found");
	});

	it("gives up after a few attempts", async () => {
		const fake = fakeArtifacts(() => {
			throw internal();
		});
		await expect(fake.store.fork("trunk", "i3k9x0a2q")).rejects.toThrow("An internal error occurred.");
		expect(fake.calls()).toBe(FORK_ATTEMPTS);
	});

	it("does not retry an error that will not go away, such as the name being taken", async () => {
		const fake = fakeArtifacts(() => {
			throw Object.assign(new Error("repo already exists"), { code: "ALREADY_EXISTS" });
		});
		await expect(fake.store.fork("trunk", "i3k9x0a2q")).rejects.toThrow("already exists");
		expect(fake.calls()).toBe(1);
	});

	it("isTransientArtifactsError recognises the errors worth another try", () => {
		expect(isTransientArtifactsError(internal())).toBe(true);
		expect(isTransientArtifactsError(Object.assign(new Error("whatever"), { code: "INTERNAL_ERROR" }))).toBe(true);
		expect(isTransientArtifactsError(new Error("request timed out"))).toBe(true);
		expect(isTransientArtifactsError(new Error("repo not found"))).toBe(false);
		expect(isTransientArtifactsError("An internal error occurred.")).toBe(false);
	});
});
