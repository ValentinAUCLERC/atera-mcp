import type { AteraClient, QueryValue } from "./client.js";

/** Atera's paginated envelope (`APIResultWrapper`). */
export type AteraPage<T = Record<string, unknown>> = {
  items?: T[];
  totalItemCount?: number;
  page?: number;
  itemsInPage?: number;
  totalPages?: number;
  nextLink?: string | null;
};

export type ListResult = {
  items: unknown[];
  page: number;
  totalPages: number | null;
  totalItems: number | null;
  hasMore: boolean;
};

export const MAX_ITEMS_IN_PAGE = 50;
export const DEFAULT_ITEMS_IN_PAGE = 20;
const SUMMARY_STRING_MAX = 300;

/** Drops null/undefined, empty strings, empty arrays and empty objects (recursively). */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compact).filter((v) => v !== undefined);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const v = compact(raw);
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
        continue;
      }
      out[key] = v;
    }
    return out;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

/** Keeps only `fields` and shortens long strings: list results must stay small for the model. */
export function summarize(item: unknown, fields: readonly string[]): unknown {
  if (item === null || typeof item !== "object") return item;
  const source = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const v = source[field];
    out[field] =
      typeof v === "string" && v.length > SUMMARY_STRING_MAX
        ? `${v.slice(0, SUMMARY_STRING_MAX)}…`
        : v;
  }
  return compact(out);
}

export function toListResult(
  page: AteraPage | null | undefined,
  requestedPage: number,
  fields: readonly string[] | null,
): ListResult {
  const items = Array.isArray(page?.items) ? page!.items : [];
  const current = page?.page ?? requestedPage;
  const totalPages = typeof page?.totalPages === "number" ? page.totalPages : null;
  return {
    items: items.map((item) => (fields ? summarize(item, fields) : compact(item))),
    page: current,
    totalPages,
    totalItems: typeof page?.totalItemCount === "number" ? page.totalItemCount : null,
    hasMore: totalPages !== null ? current < totalPages : Boolean(page?.nextLink),
  };
}

export function clampItemsInPage(n: number | undefined): number {
  if (n === undefined) return DEFAULT_ITEMS_IN_PAGE;
  return Math.max(1, Math.min(MAX_ITEMS_IN_PAGE, Math.trunc(n)));
}

export async function listPage(
  client: AteraClient,
  path: string,
  args: { page?: number; itemsInPage?: number; full?: boolean },
  fields: readonly string[],
  extraQuery: Record<string, QueryValue> = {},
): Promise<ListResult> {
  const page = Math.max(1, Math.trunc(args.page ?? 1));
  const data = await client.get<AteraPage>(path, {
    ...extraQuery,
    page,
    itemsInPage: clampItemsInPage(args.itemsInPage),
  });
  return toListResult(data, page, args.full ? null : fields);
}

export type ScanResult = {
  items: unknown[];
  scannedPages: number;
  totalPages: number | null;
  /** True when the scan stopped before the last page: there may be more matches. */
  truncated: boolean;
};

/**
 * Walks pages of 50 until `limit` matches or `maxPages` pages. Used for filters
 * the Atera API does not support server-side (name search, severity…).
 */
export async function scanPages(
  client: AteraClient,
  path: string,
  predicate: (item: Record<string, unknown>) => boolean,
  options: {
    limit: number;
    maxPages: number;
    fields: readonly string[] | null;
    query?: Record<string, QueryValue>;
  },
): Promise<ScanResult> {
  const matches: unknown[] = [];
  let totalPages: number | null = null;
  let page = 1;
  let scanned = 0;
  let reachedEnd = false;
  while (scanned < options.maxPages) {
    const data = await client.get<AteraPage>(path, {
      ...options.query,
      page,
      itemsInPage: MAX_ITEMS_IN_PAGE,
    });
    scanned++;
    const items = Array.isArray(data?.items) ? data!.items : [];
    totalPages = typeof data?.totalPages === "number" ? data.totalPages : totalPages;
    for (const item of items) {
      if (item && typeof item === "object" && predicate(item)) {
        matches.push(options.fields ? summarize(item, options.fields) : compact(item));
        if (matches.length >= options.limit) break;
      }
    }
    if (matches.length >= options.limit) break;
    const last = totalPages !== null ? page >= totalPages : items.length < MAX_ITEMS_IN_PAGE;
    if (last || items.length === 0) {
      reachedEnd = true;
      break;
    }
    page++;
  }
  return {
    items: matches,
    scannedPages: scanned,
    totalPages,
    truncated: !reachedEnd,
  };
}

export function textIncludes(haystack: unknown, needle: string): boolean {
  return typeof haystack === "string" && haystack.toLowerCase().includes(needle);
}

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

/** Removes undefined keys so Atera does not overwrite fields the caller did not mention. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
