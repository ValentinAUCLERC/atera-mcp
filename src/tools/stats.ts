import { z } from "zod";
import { buildWhere, aggregate, GROUP_BY, isOpen, type TicketFilters } from "../store/stats.js";
import type { TicketRow } from "../store/db.js";
import type { SyncStatus } from "../store/sync.js";
import { defineTool, type StatsContext, type ToolContext } from "./common.js";

const list = (what: string) =>
  z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .optional()
    .describe(`${what} (one value or a list, case-insensitive)`);

const dateBound = (what: string) =>
  z
    .string()
    .optional()
    .describe(`${what}: YYYY, YYYY-MM, YYYY-MM-DD (whole periods in the configured time zone) or an ISO date-time`);

const filters = {
  createdFrom: dateBound("Created on or after"),
  createdTo: dateBound("Created up to and including"),
  resolvedFrom: dateBound("Resolved on or after"),
  resolvedTo: dateBound("Resolved up to and including"),
  status: list("Ticket status"),
  open: z.boolean().optional().describe("true = still open (not resolved/closed), false = resolved or closed"),
  priority: list("Priority: Low, Medium, High, Critical"),
  type: list("Type: Incident, Problem, Request, Change"),
  source: list("Source, e.g. Email, Portal"),
  customerId: z.number().int().positive().optional(),
  customerName: z.string().optional().describe("Part of the customer name"),
  technicianId: z.number().int().positive().optional().describe("Technician contact ID"),
  technicianName: z.string().optional().describe("Part of the technician name or email"),
  endUser: z.string().optional().describe("Part of the end user name or email"),
  query: z.string().optional().describe("Part of the ticket title or number"),
};

type FilterArgs = {
  [K in keyof typeof filters]?: z.infer<(typeof filters)[K]>;
};

function toFilters(a: FilterArgs): TicketFilters {
  const arr = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  return {
    createdFrom: a.createdFrom,
    createdTo: a.createdTo,
    resolvedFrom: a.resolvedFrom,
    resolvedTo: a.resolvedTo,
    status: arr(a.status),
    open: a.open,
    priority: arr(a.priority),
    type: arr(a.type),
    source: arr(a.source),
    customerId: a.customerId,
    customerName: a.customerName,
    technicianId: a.technicianId,
    technicianName: a.technicianName,
    endUser: a.endUser,
    query: a.query,
  };
}

const FRESHEN_BUDGET_MS = 15_000;

const AGGREGATE_COLUMNS = [
  "id", "status", "priority", "impact", "type", "source",
  "customer_id", "customer_name", "technician_id", "technician_name", "technician_email",
  "enduser_id", "enduser_name", "enduser_email",
  "created_at", "resolved_at", "first_response_at", "first_response_due", "close_due", "total_minutes",
].join(", ");

/** Index state attached to every answer, so the model can say how fresh the numbers are. */
function indexInfo(s: SyncStatus, timeZone: string) {
  return {
    dataAsOf: s.dataAsOf,
    ticketsIndexed: s.ticketsIndexed,
    timeZone,
    ...(s.running ? { syncRunning: s.running } : {}),
    ...(s.lastError ? { lastSyncError: s.lastError } : {}),
  };
}

/** Returns the stats context once the index is usable, or a "building" answer for the model. */
async function ready(ctx: ToolContext): Promise<{ stats: StatsContext } | { notReady: unknown }> {
  const stats = ctx.stats;
  if (!stats) throw new Error("The local ticket index is disabled (set ATERA_CACHE_DIR).");
  const status = stats.sync.status();
  if (status.building) {
    const p = status.fullProgress;
    return {
      notReady: {
        indexReady: false,
        message:
          "The ticket index is still being built from Atera. Statistics will be available when it completes; try again in a few minutes.",
        progress: p ? { page: p.page, totalPages: p.totalPages } : null,
        ticketsIndexedSoFar: status.ticketsIndexed,
        ...(status.lastError ? { lastSyncError: status.lastError } : {}),
      },
    };
  }
  // Pull recent changes first, but never make the user wait long for it.
  await Promise.race([stats.sync.freshen(), new Promise((r) => setTimeout(r, FRESHEN_BUDGET_MS).unref())]);
  return { stats };
}

const iso = (ms: number | null) => (ms === null ? undefined : new Date(ms).toISOString());

function summary(r: TicketRow) {
  const resolutionHours =
    r.resolved_at !== null && r.created_at !== null && r.resolved_at >= r.created_at
      ? Math.round(((r.resolved_at - r.created_at) / 3_600_000) * 10) / 10
      : undefined;
  return {
    TicketID: r.id,
    TicketNumber: r.number ?? undefined,
    TicketTitle: r.title ?? undefined,
    TicketStatus: r.status ?? undefined,
    open: isOpen(r),
    TicketPriority: r.priority ?? undefined,
    TicketType: r.type ?? undefined,
    CustomerID: r.customer_id ?? undefined,
    CustomerName: r.customer_name ?? undefined,
    TechnicianFullName: r.technician_name ?? undefined,
    EndUser: r.enduser_name ?? r.enduser_email ?? undefined,
    created: iso(r.created_at),
    resolved: iso(r.resolved_at),
    resolutionHours,
  };
}

const SORTS = {
  created_desc: "ORDER BY created_at DESC",
  created_asc: "ORDER BY created_at ASC",
  resolved_desc: "ORDER BY resolved_at DESC",
  resolution_time_desc:
    "ORDER BY CASE WHEN resolved_at IS NULL OR created_at IS NULL THEN 1 ELSE 0 END, (resolved_at - created_at) DESC",
  oldest_open: "ORDER BY created_at ASC",
} as const;

export const statsTools = [
  defineTool({
    name: "ticket_stats",
    title: "Ticket statistics",
    description:
      "Statistics over ALL tickets from the local index (no Atera paging): counts, open/resolved, resolution and first-response times (avg/median/p90, hours), SLA compliance and work hours, optionally grouped by status, priority, type, source, customer, technician, end user, or by day/week/month/year of creation or resolution. Use this for any count, trend, ranking or average instead of listing tickets.",
    toolset: "stats",
    access: "read",
    needsIndex: true,
    input: {
      ...filters,
      groupBy: z.enum(GROUP_BY).optional().describe("Default none (a single total)"),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum groups returned (default 25)"),
    },
    handler: async (args, _client, ctx) => {
      const r = await ready(ctx);
      if ("notReady" in r) return r.notReady;
      const { store, sync, timeZone } = r.stats;
      const { where, params } = buildWhere(toFilters(args), timeZone);
      // Titles and numbers are not needed for aggregates: keep memory low on large indexes.
      const rows = store.query(where, params, AGGREGATE_COLUMNS);
      const groupBy = args.groupBy ?? "none";
      const { groups, otherGroups, total } = aggregate(rows, groupBy, timeZone, args.limit ?? 25);
      return {
        index: indexInfo(sync.status(), timeZone),
        groupBy,
        total,
        ...(groupBy !== "none" ? { groups } : {}),
        ...(otherGroups ? { otherGroups } : {}),
      };
    },
  }),

  defineTool({
    name: "search_tickets",
    title: "Search tickets (index)",
    description:
      "Find tickets in the local index with filters Atera's API lacks: creation/resolution date ranges, technician, end user, title text, several statuses at once. Returns up to 50 tickets plus the total number of matches. For counts or averages use ticket_stats.",
    toolset: "stats",
    access: "read",
    needsIndex: true,
    input: {
      ...filters,
      sort: z
        .enum(["created_desc", "created_asc", "resolved_desc", "resolution_time_desc", "oldest_open"])
        .optional()
        .describe("Default created_desc"),
      limit: z.number().int().min(1).max(50).optional().describe("Default 20, max 50"),
      offset: z.number().int().min(0).optional().describe("Skip this many matches (paging)"),
    },
    handler: async (args, _client, ctx) => {
      const r = await ready(ctx);
      if ("notReady" in r) return r.notReady;
      const { store, sync, timeZone } = r.stats;
      const f = toFilters(args);
      if (args.sort === "oldest_open" && f.open === undefined) f.open = true;
      const { where, params } = buildWhere(f, timeZone);
      const totalMatches = (store.db.prepare(`SELECT COUNT(*) AS n FROM tickets ${where}`).get(...params) as { n: number }).n;
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const rows = store.query(`${where} ${SORTS[args.sort ?? "created_desc"]} LIMIT ? OFFSET ?`, [...params, limit, offset]);
      return {
        index: indexInfo(sync.status(), timeZone),
        totalMatches,
        offset,
        hasMore: offset + rows.length < totalMatches,
        items: rows.map(summary),
      };
    },
  }),

  defineTool({
    name: "ticket_index_status",
    title: "Ticket index status",
    description: "State of the local ticket index: tickets indexed, last syncs, build progress, last error.",
    toolset: "stats",
    access: "read",
    needsIndex: true,
    input: {},
    handler: async (_args, _client, ctx) => {
      if (!ctx.stats) throw new Error("The local ticket index is disabled (set ATERA_CACHE_DIR).");
      return { ...ctx.stats.sync.status(), timeZone: ctx.stats.timeZone };
    },
  }),
];
