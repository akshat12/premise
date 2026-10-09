import { isBlank, visibleLength } from "../util/strings.js";

export interface Profile {
	userId: string;
	displayName: string;
	bio: string;
	timezone: string;
	/** BCP 47 language tag, e.g. "en-GB". */
	locale: string;
}

export type ProfileUpdate = Partial<Omit<Profile, "userId">>;

export const MAX_BIO_LENGTH = 280;
export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_LOCALE = "en-US";

export interface ProfileProblem {
	field: keyof ProfileUpdate;
	message: string;
}

export function defaultProfile(userId: string, displayName: string): Profile {
	return { userId, displayName, bio: "", timezone: DEFAULT_TIMEZONE, locale: DEFAULT_LOCALE };
}

/** Everything wrong with a proposed update. An empty list means it can be applied. */
export function validateProfile(update: ProfileUpdate): ProfileProblem[] {
	const problems: ProfileProblem[] = [];
	if (update.displayName !== undefined && isBlank(update.displayName)) {
		problems.push({ field: "displayName", message: "Display name cannot be empty." });
	}
	if (update.bio !== undefined && visibleLength(update.bio) > MAX_BIO_LENGTH) {
		problems.push({ field: "bio", message: `Bio must be at most ${MAX_BIO_LENGTH} characters.` });
	}
	if (update.timezone !== undefined && !/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(update.timezone)) {
		problems.push({ field: "timezone", message: "Timezone must be an IANA name such as Europe/London." });
	}
	if (update.locale !== undefined && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(update.locale)) {
		problems.push({ field: "locale", message: "Locale must look like en or en-GB." });
	}
	return problems;
}

/** Returns the profile with the update applied. Text fields are trimmed. Does not validate. */
export function applyProfileUpdate(profile: Profile, update: ProfileUpdate): Profile {
	return {
		...profile,
		...update,
		displayName: (update.displayName ?? profile.displayName).trim(),
		bio: (update.bio ?? profile.bio).trim(),
	};
}

export function isProfileComplete(profile: Profile): boolean {
	return !isBlank(profile.displayName) && !isBlank(profile.bio);
}
