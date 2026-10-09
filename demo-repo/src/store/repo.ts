import type { Invoice } from "../billing/invoice.js";
import type { User } from "../users/user.js";

/** The minimum every store offers. */
export interface Repository<T extends { id: string }> {
	get(id: string): T | undefined;
	put(item: T): void;
	delete(id: string): boolean;
	all(): T[];
}

export interface UserRepository extends Repository<User> {
	findByEmail(email: string): User | undefined;
}

export interface InvoiceRepository extends Repository<Invoice> {
	forUser(userId: string): Invoice[];
}

export interface PageRequest {
	/** 1-based. */
	page: number;
	pageSize: number;
}

export interface Page<T> {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
	hasMore: boolean;
}

export const DEFAULT_PAGE: PageRequest = { page: 1, pageSize: 20 };
export const MAX_PAGE_SIZE = 100;

/** Slices `items` into the requested page. Out-of-range requests are clamped, not rejected. */
export function paginate<T>(items: readonly T[], request: PageRequest = DEFAULT_PAGE): Page<T> {
	const pageSize = Math.min(Math.max(1, Math.floor(request.pageSize)), MAX_PAGE_SIZE);
	const page = Math.max(1, Math.floor(request.page));
	const start = (page - 1) * pageSize;
	return {
		items: items.slice(start, start + pageSize),
		page,
		pageSize,
		total: items.length,
		hasMore: start + pageSize < items.length,
	};
}

export function pageCount(total: number, pageSize: number): number {
	return pageSize <= 0 ? 0 : Math.ceil(total / pageSize);
}
