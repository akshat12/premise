import { constantTimeEqual, saltedHash } from "../util/hash.js";

export interface PasswordPolicy {
	minLength: number;
	/** Require both an upper-case and a lower-case letter. */
	requireMixedCase: boolean;
	/** Require at least one digit. Declared for configuration files; not enforced yet. */
	requireDigit: boolean;
}

export type PasswordIssue = "too_short" | "needs_mixed_case" | "needs_digit" | "has_whitespace";

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
	minLength: 10,
	requireMixedCase: true,
	requireDigit: false,
};

/** Everything wrong with a candidate password. An empty list means it is acceptable. */
export function checkPasswordPolicy(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): PasswordIssue[] {
	const issues: PasswordIssue[] = [];
	if (password.length < policy.minLength) {
		issues.push("too_short");
	}
	if (policy.requireMixedCase && !(/[a-z]/.test(password) && /[A-Z]/.test(password))) {
		issues.push("needs_mixed_case");
	}
	if (/\s/.test(password)) {
		issues.push("has_whitespace");
	}
	return issues;
}

export function isAcceptablePassword(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): boolean {
	return checkPasswordPolicy(password, policy).length === 0;
}

export interface PasswordRecord {
	salt: string;
	digest: string;
}

/** Derives the stored form of a password. The salt must be unique per user. */
export function hashPassword(password: string, salt: string): PasswordRecord {
	return { salt, digest: saltedHash(password, salt, 16) };
}

export function verifyPassword(password: string, stored: PasswordRecord): boolean {
	return constantTimeEqual(hashPassword(password, stored.salt).digest, stored.digest);
}

export function describeIssue(issue: PasswordIssue, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string {
	switch (issue) {
		case "too_short":
			return `Use at least ${policy.minLength} characters.`;
		case "needs_mixed_case":
			return "Use both upper-case and lower-case letters.";
		case "needs_digit":
			return "Include at least one digit.";
		case "has_whitespace":
			return "Do not use spaces.";
	}
}
