import { ValidationError } from "../util/errors.js";
import { hashString } from "../util/hash.js";
import type { IdGenerator } from "../util/ids.js";
import { normalizeEmail } from "../util/strings.js";
import { type Clock, DAY } from "../util/time.js";
import type { Role } from "./roles.js";
import { isValidEmail } from "./user.js";

export interface Invite {
	id: string;
	email: string;
	role: Role;
	invitedBy: string;
	/** Sent to the invitee; needed to accept. */
	code: string;
	expiresAt: number;
	acceptedAt: number | null;
}

export const INVITE_TTL_MS = 7 * DAY;

/** Creates an invitation for `email` to join with `role`. */
export function createInvite(email: string, role: Role, invitedBy: string, ids: IdGenerator, now: Clock): Invite {
	if (!isValidEmail(email)) {
		throw new ValidationError("email is not valid", ["email"]);
	}
	const id = ids();
	return {
		id,
		email: normalizeEmail(email),
		role,
		invitedBy,
		code: hashString(`${id}:${normalizeEmail(email)}`),
		expiresAt: now() + INVITE_TTL_MS,
		acceptedAt: null,
	};
}

export function isInviteExpired(invite: Invite, now: Clock): boolean {
	return invite.expiresAt <= now();
}

export type InviteOutcome = "accepted" | "expired" | "already_accepted" | "wrong_code";

/** Checks an acceptance attempt and says what should happen. */
export function checkInvite(invite: Invite, code: string, now: Clock): InviteOutcome {
	if (invite.acceptedAt !== null) {
		return "already_accepted";
	}
	if (isInviteExpired(invite, now)) {
		return "expired";
	}
	return invite.code === code ? "accepted" : "wrong_code";
}

/** Marks an invite accepted. Call only after checkInvite returned "accepted". */
export function acceptInvite(invite: Invite, now: Clock): Invite {
	return { ...invite, acceptedAt: now() };
}

export function pendingInvites(invites: readonly Invite[], now: Clock): Invite[] {
	return invites.filter((invite) => invite.acceptedAt === null && !isInviteExpired(invite, now));
}
