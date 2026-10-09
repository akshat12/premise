import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { chunk, groupBy, sortBy, sumBy, uniqueBy } from "../src/util/collections.js";
import { AppError, errorCode, NotFoundError, ValidationError } from "../src/util/errors.js";
import { combineHashes, constantTimeEqual, hashString, saltedHash } from "../src/util/hash.js";
import { isPrefixedId, parsePrefixedId, seededIds, sequentialIds } from "../src/util/ids.js";
import { collectResults, err, mapResult, ok, unwrap, unwrapOr } from "../src/util/result.js";
import { normalizeEmail, slugify, truncate, visibleLength } from "../src/util/strings.js";
import { DAY, daysBetween, formatIsoDate, startOfDay, startOfYear, tickingClock, yearOf } from "../src/util/time.js";

export const tests: Tests = {
	"time: calendar helpers work in UTC": () => {
		const at = Date.UTC(2026, 6, 4, 15, 30);
		assert.eq(formatIsoDate(at), "2026-07-04");
		assert.eq(yearOf(at), 2026);
		assert.eq(startOfDay(at), Date.UTC(2026, 6, 4));
		assert.eq(startOfYear(at), Date.UTC(2026, 0, 1));
		assert.eq(daysBetween(startOfYear(at), at), 184);
	},
	"time: a ticking clock advances by its step": () => {
		const clock = tickingClock(1000, 250);
		assert.deepEq([clock(), clock(), clock()], [1000, 1250, 1500]);
		assert.eq(DAY, 86_400_000);
	},
	"ids: sequential ids are padded and recognisable": () => {
		const ids = sequentialIds("user");
		assert.deepEq([ids(), ids()], ["usr_000001", "usr_000002"]);
		assert.ok(isPrefixedId("usr_000002", "user"));
		assert.ok(!isPrefixedId("usr_000002", "invoice"));
		assert.deepEq(parsePrefixedId("inv_000042"), { kind: "invoice", sequence: 42 });
		assert.eq(parsePrefixedId("nope_1"), null);
	},
	"ids: seeded ids repeat for the same seed": () => {
		const a = seededIds("session", 7);
		const b = seededIds("session", 7);
		assert.deepEq([a(), a(), a()], [b(), b(), b()]);
		assert.ok(a() !== seededIds("session", 8)());
	},
	"hash: digests are stable and sensitive to input": () => {
		assert.eq(hashString("acme"), hashString("acme"));
		assert.eq(hashString("acme").length, 16);
		assert.ok(hashString("acme") !== hashString("acmf"));
		assert.ok(saltedHash("pw", "a") !== saltedHash("pw", "b"));
		assert.ok(combineHashes(["a", "b"]) !== combineHashes(["b", "a"]));
	},
	"hash: constantTimeEqual compares whole strings": () => {
		assert.ok(constantTimeEqual("abc", "abc"));
		assert.ok(!constantTimeEqual("abc", "abd"));
		assert.ok(!constantTimeEqual("abc", "abcd"));
	},
	"result: helpers compose": () => {
		assert.deepEq(mapResult(ok(2), (n) => n * 2), ok(4));
		assert.eq(unwrapOr(err("no"), 9), 9);
		assert.eq(unwrap(ok("yes")), "yes");
		assert.throws(() => unwrap(err("boom")));
		assert.deepEq(collectResults([ok(1), ok(2)]), ok([1, 2]));
		assert.deepEq(collectResults([ok(1), err("a"), err("b")]), err(["a", "b"]));
	},
	"errors: codes come from the error class": () => {
		assert.eq(errorCode(new NotFoundError("invoice")), "not_found");
		assert.eq(errorCode(new ValidationError("bad", ["email"])), "validation");
		assert.eq(errorCode(new Error("anything")), "internal");
		assert.ok(new NotFoundError("x") instanceof AppError);
		assert.eq(new NotFoundError("invoice").message, "invoice not found");
	},
	"strings: normalise, slug and truncate": () => {
		assert.eq(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
		assert.eq(slugify("Ada Lovelace!"), "ada-lovelace");
		assert.eq(truncate("abcdefgh", 5), "abcd…");
		assert.eq(truncate("abc", 5), "abc");
		assert.eq(visibleLength("naïve 👍"), 7);
	},
	"collections: group, sum, unique, sort, chunk": () => {
		const items = [{ k: "a", n: 2 }, { k: "b", n: 1 }, { k: "a", n: 5 }];
		assert.eq(groupBy(items, (i) => i.k).get("a")?.length, 2);
		assert.eq(sumBy(items, (i) => i.n), 8);
		assert.deepEq(uniqueBy(items, (i) => i.k).map((i) => i.n), [2, 1]);
		assert.deepEq(sortBy(items, (i) => i.n).map((i) => i.n), [1, 2, 5]);
		assert.deepEq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	},
};
