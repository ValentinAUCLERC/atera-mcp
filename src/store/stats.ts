import type { TicketRow } from "./db.js";

export const CLOSED_STATUSES = ["resolved", "closed"];

export type TicketFilters = {
  createdFrom?: string;
  createdTo?: string;
  resolvedFrom?: string;
  resolvedTo?: string;
  status?: string[];
  open?: boolean;
  priority?: string[];
  type?: string[];
  source?: string[];
  customerId?: number;
  customerName?: string;
  technicianId?: number;
  technicianName?: string;
  endUser?: string;
  query?: string;
};

export const GROUP_BY = [
  "none",
  "status",
  "priority",
  "impact",
  "type",
  "source",
  "customer",
  "technician",
  "enduser",
  "created_day",
  "created_week",
  "created_month",
  "created_year",
  "resolved_day",
  "resolved_week",
  "resolved_month",
  "resolved_year",
] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/** Builds a parameterised WHERE clause. Dates without time are whole days in `timeZone`. */
export function buildWhere(f: TicketFilters, timeZone: string): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  const range = (column: string, from?: string, to?: string) => {
    if (from) {
      clauses.push(`${column} >= ?`);
      params.push(parseBound(from, timeZone, "start"));
    }
    if (to) {
      clauses.push(`${column} < ?`);
      params.push(parseBound(to, timeZone, "end"));
    }
  };
  range("created_at", f.createdFrom, f.createdTo);
  range("resolved_at", f.resolvedFrom, f.resolvedTo);

  const inList = (column: string, values?: string[]) => {
    const v = (values ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (v.length === 0) return;
    clauses.push(`LOWER(${column}) IN (${v.map(() => "?").join(",")})`);
    params.push(...v);
  };
  inList("status", f.status);
  inList("priority", f.priority);
  inList("type", f.type);
  inList("source", f.source);

  if (f.open === true) {
    clauses.push(`resolved_at IS NULL AND LOWER(COALESCE(status, '')) NOT IN (${CLOSED_STATUSES.map(() => "?").join(",")})`);
    params.push(...CLOSED_STATUSES);
  } else if (f.open === false) {
    clauses.push(`(resolved_at IS NOT NULL OR LOWER(COALESCE(status, '')) IN (${CLOSED_STATUSES.map(() => "?").join(",")}))`);
    params.push(...CLOSED_STATUSES);
  }

  const contains = (columns: string[], value?: string) => {
    if (!value || value.trim() === "") return;
    clauses.push(`(${columns.map((c) => `LOWER(COALESCE(${c}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    const like = `%${value.trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(...columns.map(() => like));
  };
  if (f.customerId !== undefined) {
    clauses.push("customer_id = ?");
    params.push(f.customerId);
  }
  if (f.technicianId !== undefined) {
    clauses.push("technician_id = ?");
    params.push(f.technicianId);
  }
  contains(["customer_name"], f.customerName);
  contains(["technician_name", "technician_email"], f.technicianName);
  contains(["enduser_name", "enduser_email"], f.endUser);
  contains(["title", "number"], f.query);

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** "2026-09-01" → start (or end, exclusive) of that day in `timeZone`; full timestamps are used as-is. */
export function parseBound(value: string, timeZone: string, side: "start" | "end"): number {
  const v = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  const year = /^(\d{4})$/.exec(v);
  if (day || month || year) {
    const y = Number((day ?? month ?? year)![1]);
    const m = day || month ? Number((day ?? month)![2]) - 1 : 0;
    const d = day ? Number(day[3]) : 1;
    if (side === "start") return zonedMidnight(y, m, d, timeZone);
    // End is exclusive: the start of the next day / month / year.
    if (day) return zonedMidnight(y, m, d + 1, timeZone);
    if (month) return zonedMidnight(y, m + 1, 1, timeZone);
    return zonedMidnight(y + 1, 0, 1, timeZone);
  }
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`Invalid date "${value}": use YYYY, YYYY-MM, YYYY-MM-DD or an ISO 8601 date-time.`);
  return ms;
}

/** UTC timestamp of local midnight of y-m-d in `timeZone` (m is 0-based and may overflow). */
export function zonedMidnight(y: number, m: number, d: number, timeZone: string): number {
  const guess = Date.UTC(y, m, d);
  const first = guess - tzOffsetMs(guess, timeZone);
  // Second pass handles days where the offset changes (DST).
  return guess - tzOffsetMs(first, timeZone);
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  return offsetAt(utcMs, timeZone);
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Offset of `timeZone` at `utcMs`, cached per UTC hour (Intl is slow; offsets change on hour boundaries). */
function offsetAt(utcMs: number, timeZone: string): number {
  const hour = Math.floor(utcMs / 3_600_000);
  const key = `${timeZone}|${hour}`;
  let offset = offsetCache.get(key);
  if (offset === undefined) {
    const at = hour * 3_600_000;
    const out: Record<string, number> = {};
    for (const part of formatter(timeZone).formatToParts(new Date(at))) {
      if (part.type !== "literal") out[part.type] = Number(part.value);
    }
    offset = Date.UTC(out.year!, out.month! - 1, out.day!, out.hour!, out.minute!, out.second!) - at;
    if (offsetCache.size > 200_000) offsetCache.clear();
    offsetCache.set(key, offset);
  }
  return offset;
}

function localParts(utcMs: number, timeZone: string) {
  const d = new Date(utcMs + offsetAt(utcMs, timeZone));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Unknown time zone "${timeZone}" (use an IANA name such as Europe/Paris).`);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function periodKey(ms: number | null, unit: "day" | "week" | "month" | "year", timeZone: string): string | null {
  if (ms === null) return null;
  const p = localParts(ms, timeZone);
  if (unit === "year") return String(p.year);
  if (unit === "month") return `${p.year}-${pad(p.month)}`;
  if (unit === "day") return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  // ISO 8601 week.
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export function isOpen(r: TicketRow): boolean {
  return r.resolved_at === null && !CLOSED_STATUSES.includes((r.status ?? "").toLowerCase());
}

type GroupKey = { key: string; label?: string };

function groupKey(r: TicketRow, by: GroupBy, timeZone: string): GroupKey {
  const unknown = { key: "(none)" };
  switch (by) {
    case "none":
      return { key: "all" };
    case "status":
      return r.status ? { key: r.status } : unknown;
    case "priority":
      return r.priority ? { key: r.priority } : unknown;
    case "impact":
      return r.impact ? { key: r.impact } : unknown;
    case "type":
      return r.type ? { key: r.type } : unknown;
    case "source":
      return r.source ? { key: r.source } : unknown;
    case "customer":
      return r.customer_id !== null ? { key: String(r.customer_id), label: r.customer_name ?? undefined } : unknown;
    case "technician":
      return r.technician_id !== null
        ? { key: String(r.technician_id), label: r.technician_name ?? r.technician_email ?? undefined }
        : { key: "(unassigned)" };
    case "enduser":
      return r.enduser_id !== null
        ? { key: String(r.enduser_id), label: r.enduser_name ?? r.enduser_email ?? undefined }
        : unknown;
    default: {
      const [field, unit] = by.split("_") as ["created" | "resolved", "day" | "week" | "month" | "year"];
      const key = periodKey(field === "created" ? r.created_at : r.resolved_at, unit, timeZone);
      return key ? { key } : unknown;
    }
  }
}

export type GroupStats = {
  key: string;
  label?: string;
  count: number;
  open: number;
  resolved: number;
  resolutionHours?: { avg: number; median: number; p90: number };
  firstResponseHours?: { avg: number; median: number };
  firstResponseSlaMetPct?: number;
  resolutionSlaMetPct?: number;
  workHours?: number;
};

export function aggregate(
  rows: TicketRow[],
  by: GroupBy,
  timeZone: string,
  limit: number,
): { groups: GroupStats[]; otherGroups: { groups: number; count: number } | null; total: GroupStats } {
  const buckets = new Map<string, { label?: string; rows: TicketRow[] }>();
  for (const r of rows) {
    const g = groupKey(r, by, timeZone);
    let bucket = buckets.get(g.key);
    if (!bucket) {
      bucket = { label: g.label, rows: [] };
      buckets.set(g.key, bucket);
    }
    if (!bucket.label && g.label) bucket.label = g.label;
    bucket.rows.push(r);
  }

  let groups = [...buckets.entries()].map(([key, b]) => stats(key, b.label, b.rows));
  const isPeriod = by.endsWith("_day") || by.endsWith("_week") || by.endsWith("_month") || by.endsWith("_year");
  groups.sort((a, b) =>
    isPeriod ? a.key.localeCompare(b.key) : b.count - a.count || a.key.localeCompare(b.key),
  );

  let otherGroups: { groups: number; count: number } | null = null;
  if (groups.length > limit) {
    // Time series keep the most recent periods; categories keep the largest groups.
    const kept = isPeriod ? groups.slice(-limit) : groups.slice(0, limit);
    const dropped = isPeriod ? groups.slice(0, groups.length - limit) : groups.slice(limit);
    otherGroups = { groups: dropped.length, count: dropped.reduce((n, g) => n + g.count, 0) };
    groups = kept;
  }
  return { groups, otherGroups, total: stats("total", undefined, rows) };
}

function stats(key: string, label: string | undefined, rows: TicketRow[]): GroupStats {
  const hours = (ms: number) => ms / 3_600_000;
  const resolution = rows
    .filter((r) => r.resolved_at !== null && r.created_at !== null && r.resolved_at >= r.created_at)
    .map((r) => hours(r.resolved_at! - r.created_at!));
  const firstResponse = rows
    .filter((r) => r.first_response_at !== null && r.created_at !== null && r.first_response_at >= r.created_at)
    .map((r) => hours(r.first_response_at! - r.created_at!));
  const frSla = rows.filter((r) => r.first_response_due !== null && r.first_response_at !== null);
  const resSla = rows.filter((r) => r.close_due !== null && r.resolved_at !== null);
  const work = rows.reduce((n, r) => n + (r.total_minutes ?? 0), 0);

  const out: GroupStats = {
    key,
    ...(label ? { label } : {}),
    count: rows.length,
    open: rows.filter(isOpen).length,
    resolved: rows.filter((r) => !isOpen(r)).length,
  };
  if (resolution.length > 0) {
    out.resolutionHours = { avg: round(mean(resolution)), median: round(quantile(resolution, 0.5)), p90: round(quantile(resolution, 0.9)) };
  }
  if (firstResponse.length > 0) {
    out.firstResponseHours = { avg: round(mean(firstResponse)), median: round(quantile(firstResponse, 0.5)) };
  }
  if (frSla.length > 0) {
    out.firstResponseSlaMetPct = round((100 * frSla.filter((r) => r.first_response_at! <= r.first_response_due!).length) / frSla.length, 1);
  }
  if (resSla.length > 0) {
    out.resolutionSlaMetPct = round((100 * resSla.filter((r) => r.resolved_at! <= r.close_due!).length) / resSla.length, 1);
  }
  if (work > 0) out.workHours = round(work / 60, 1);
  return out;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
