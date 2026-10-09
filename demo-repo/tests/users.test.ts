import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { addUser, createDirectory, directoryStats, findByEmail, listByRole, removeUser, searchUsers } from "../src/users/directory.js";
import { acceptInvite, checkInvite, createInvite, INVITE_TTL_MS, pendingInvites } from "../src/users/invite.js";
import { applyProfileUpdate, defaultProfile, isProfileComplete, validateProfile } from "../src/users/profile.js";
import { grantRole, hasRole, highestRole, isAtLeast, isRole, revokeRole } from "../src/users/roles.js";
import { createUser, deactivateUser, displayName, isActive, publicUser } from "../src/users/user.js";
import { ConflictError, ValidationError } from "../src/util/errors.js";
import { sequentialIds } from "../src/util/ids.js";
import { fixedClock } from "../src/util/time.js";
import { makeUser, now, T0 } from "./support.js";

export const tests: Tests = {
	"createUser normalises the email and applies defaults": () => {
		const user = createUser({ email: " Grace@Example.com ", name: " Grace Hopper ", password: { salt: "s", digest: "d" } }, sequentialIds("user"), now);
		assert.eq(user.id, "usr_000001");
		assert.eq(user.email, "grace@example.com");
		assert.eq(user.name, "Grace Hopper");
		assert.deepEq(user.roles, ["member"]);
		assert.eq(user.createdAt, T0);
		assert.ok(isActive(user));
	},
	"createUser rejects a bad email or an empty name": () => {
		const ids = sequentialIds("user");
		const password = { salt: "s", digest: "d" };
		assert.throws(() => createUser({ email: "not-an-email", name: "X", password }, ids, now), ValidationError);
		assert.throws(() => createUser({ email: "x@example.com", name: "  ", password }, ids, now), ValidationError);
	},
	"users can be deactivated and are returned without their password": () => {
		const user = deactivateUser(makeUser());
		assert.ok(!isActive(user));
		assert.ok(!("password" in publicUser(user)));
		assert.eq(displayName({ name: "", email: "ada@example.com" }), "ada");
	},
	"roles: grant keeps rank order and removes duplicates": () => {
		assert.deepEq(grantRole(["admin", "viewer"], "member"), ["viewer", "member", "admin"]);
		assert.deepEq(grantRole(["member"], "member"), ["member"]);
	},
	"roles: revoke never leaves a user with no role": () => {
		assert.deepEq(revokeRole(["member", "admin"], "admin"), ["member"]);
		assert.deepEq(revokeRole(["member"], "member"), ["viewer"]);
	},
	"roles: rank comparisons": () => {
		assert.ok(isAtLeast(["billing"], "member"));
		assert.ok(!isAtLeast(["viewer"], "member"));
		assert.eq(highestRole(["member", "admin", "viewer"]), "admin");
		assert.eq(highestRole([]), undefined);
		assert.ok(hasRole(["member"], "member"));
		assert.ok(isRole("admin") && !isRole("root"));
	},
	"profile: validation reports each bad field": () => {
		assert.deepEq(validateProfile({ displayName: "Ada", bio: "Hi", timezone: "Europe/London", locale: "en-GB" }), []);
		const problems = validateProfile({ displayName: "  ", bio: "x".repeat(281), timezone: "not a zone", locale: "english" });
		assert.deepEq(problems.map((problem) => problem.field), ["displayName", "bio", "timezone", "locale"]);
	},
	"profile: updates are applied and trimmed": () => {
		const profile = applyProfileUpdate(defaultProfile("usr_000001", "Ada"), { bio: "  Mathematician  ", locale: "en-GB" });
		assert.eq(profile.bio, "Mathematician");
		assert.eq(profile.locale, "en-GB");
		assert.eq(profile.displayName, "Ada");
		assert.ok(isProfileComplete(profile));
	},
	"directory: lookup by email and conflict on duplicates": () => {
		const directory = createDirectory([makeUser()]);
		assert.eq(findByEmail(directory, "ADA@example.com")?.id, "usr_000001");
		assert.throws(() => addUser(directory, makeUser({ id: "usr_000002" })), ConflictError);
		addUser(directory, makeUser({ name: "Ada L." }));
		assert.eq(directory.byId.size, 1);
		assert.ok(removeUser(directory, "usr_000001"));
		assert.eq(findByEmail(directory, "ada@example.com"), undefined);
	},
	"directory: search, role listing and stats": () => {
		const directory = createDirectory([
			makeUser(),
			makeUser({ id: "usr_000002", email: "grace@example.com", name: "Grace Hopper", roles: ["admin"] }),
			makeUser({ id: "usr_000003", email: "linus@example.org", name: "Linus", status: "deactivated", roles: ["viewer"] }),
		]);
		assert.deepEq(searchUsers(directory, "example.com").map((user) => user.name), ["Ada Lovelace", "Grace Hopper"]);
		assert.deepEq(searchUsers(directory, "LIN").map((user) => user.id), ["usr_000003"]);
		assert.deepEq(listByRole(directory, "billing").map((user) => user.id), ["usr_000002"]);
		assert.deepEq(directoryStats(directory), {
			total: 3,
			byStatus: { active: 2, invited: 0, deactivated: 1 },
			byRole: { viewer: 1, member: 1, billing: 0, admin: 1 },
		});
	},
	"invites: accept with the right code before expiry": () => {
		const invite = createInvite("New@Example.com", "member", "usr_000001", sequentialIds("invite"), now);
		assert.eq(invite.email, "new@example.com");
		assert.eq(checkInvite(invite, "wrong", now), "wrong_code");
		assert.eq(checkInvite(invite, invite.code, now), "accepted");
		assert.eq(checkInvite(invite, invite.code, fixedClock(T0 + INVITE_TTL_MS)), "expired");
		const accepted = acceptInvite(invite, now);
		assert.eq(checkInvite(accepted, invite.code, now), "already_accepted");
		assert.deepEq(pendingInvites([invite, accepted], now), [invite]);
	},
};
