import { describe, expect, it } from "vitest";
import { AteraClient, type FetchLike } from "../src/client.js";
import { openStoreWith, parseAteraDate, ticketToRow } from "../src/store/db.js";
import { aggregate, buildWhere, parseBound, periodKey, quantile } from "../src/store/stats.js";
import { TicketSync } from "../src/store/sync.js";

// node:sqlite exists from Node 22.13: the index is optional, so these tests are skipped on Node 20.
const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
const hasSqlite = major > 22 || (major === 22 && minor >= 13);
const { DatabaseSync } = hasSqlite ? await import("node:sqlite") : ({} as typeof import("node:sqlite"));
const suite = describe.skipIf(!hasSqlite);

type Ticket = Record<string, unknown> & { TicketID: number };

function ticket(id: number, extra: Record<string, unknown> = {}): Ticket {
  return {
    TicketID: id,
    TicketNumber: String(id),
    TicketTitle: `Ticket ${id}`,
    TicketStatus: "Open",
    TicketPriority: "Medium",
    TicketType: "Incident",
    CustomerID: 1,
    CustomerName: "ACME",
    TicketCreatedDate: "2026-09-01T08:00:00",
    ...extra,
  };
}

/** In-memory Atera: /tickets pages, /tickets/lastmodified, /tickets/{id}. */
function fakeAtera(initial: Ticket[]) {
  const state = {
    tickets: new Map(initial.map((t) => [t.TicketID, t])),
    modified: [] as Ticket[],
    failAtPage: 0,
    /** Pages containing this ticket time out unless they are at most `heavyMaxSize` items. */
    heavyId: 0,
    heavyMaxSize: 5,
  };
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input);
    calls.push(`${url.pathname}?${url.searchParams}`);
    const page = Number(url.searchParams.get("page") ?? 1);
    const size = Number(url.searchParams.get("itemsInPage") ?? 20);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const paged = (items: Ticket[]) =>
      json({
        items: items.slice((page - 1) * size, page * size),
        page,
        totalPages: Math.max(1, Math.ceil(items.length / size)),
        totalItemCount: items.length,
      });
    if (url.pathname === "/api/v3/tickets") {
      if (state.failAtPage === page) return json({ Message: "boom" }, 400);
      const all = [...state.tickets.values()].sort((a, b) => a.TicketID - b.TicketID);
      const slice = all.slice((page - 1) * size, page * size);
      if (slice.some((t) => t.TicketID === state.heavyId) && size > state.heavyMaxSize) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return paged(all);
    }
    if (url.pathname === "/api/v3/tickets/lastmodified") return paged(state.modified);
    const one = /^\/api\/v3\/tickets\/(\d+)$/.exec(url.pathname);
    if (one) {
      const t = state.tickets.get(Number(one[1]));
      return t ? json(t) : json({ Message: "not found" }, 404);
    }
    return json({}, 404);
  };
  return { state, calls, fetchImpl };
}

function setup(initial: Ticket[]) {
  const atera = fakeAtera(initial);
  const store = openStoreWith(new DatabaseSync(":memory:"));
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const sleeps: number[] = [];
  const client = new AteraClient(
    { apiKey: "k", baseUrl: "https://atera.test/api/v3", timeoutMs: 1000 },
    atera.fetchImpl,
    async () => {},
  );
  const sync = new TicketSync(store, client, {
    requestsPerMinute: 600,
    log: () => {},
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { atera, store, sync, sleeps, now: () => clock, advance: (ms: number) => (clock += ms) };
}

describe("parseAteraDate", () => {
  it("treats dates without offset as UTC and ignores placeholders", () => {
    expect(parseAteraDate("2026-09-01T08:00:00")).toBe(Date.parse("2026-09-01T08:00:00Z"));
    expect(parseAteraDate("2026-09-01T08:00:00+02:00")).toBe(Date.parse("2026-09-01T06:00:00Z"));
    expect(parseAteraDate("0001-01-01T00:00:00")).toBeNull();
    expect(parseAteraDate("")).toBeNull();
    expect(parseAteraDate(null)).toBeNull();
  });

  it("maps a ticket to a row", () => {
    const row = ticketToRow(
      ticket(5, { EndUserFirstName: "Marie", EndUserLastName: "Dupont", TicketResolvedDate: "2026-09-01T10:30:00" }),
      1,
      "run",
    )!;
    expect(row).toMatchObject({ id: 5, enduser_name: "Marie Dupont", customer_id: 1, seen_run: "run" });
    expect(row.resolved_at! - row.created_at!).toBe(150 * 60_000);
    expect(ticketToRow({ TicketTitle: "no id" }, 1, null)).toBeNull();
  });
});

suite("TicketSync", () => {
  it("builds the index with a full run, throttled", async () => {
    const tickets = Array.from({ length: 120 }, (_, i) => ticket(i + 1));
    const { store, sync, atera, sleeps } = setup(tickets);
    expect(sync.status().building).toBe(true);
    await sync.tick();
    expect(store.count()).toBe(120);
    const status = sync.status();
    expect(status.building).toBe(false);
    expect(status.lastFullAt).not.toBeNull();
    expect(status.lastIncrementalAt).not.toBeNull();
    expect(atera.calls.filter((c) => c.startsWith("/api/v3/tickets?"))).toHaveLength(3);
    // 600 req/min → at least 100 ms between requests.
    expect(sleeps.every((ms) => ms <= 100)).toBe(true);
  });

  it("resumes an interrupted full run from the saved page", async () => {
    const tickets = Array.from({ length: 150 }, (_, i) => ticket(i + 1));
    const { store, sync, atera, advance } = setup(tickets);
    atera.state.failAtPage = 2;
    await sync.tick();
    expect(sync.status().building).toBe(true);
    expect(sync.status().lastError).toContain("full sync failed");
    expect(sync.status().fullProgress).toEqual({ page: 2, totalPages: 3 });
    expect(store.count()).toBe(50);

    atera.state.failAtPage = 0;
    advance(6 * 60_000); // past the error backoff
    await sync.tick();
    expect(sync.status().building).toBe(false);
    expect(store.count()).toBe(150);
    // Page 1 was not fetched again.
    expect(atera.calls.filter((c) => c.includes("page=1&") && c.startsWith("/api/v3/tickets?"))).toHaveLength(1);
  });

  it("applies incremental changes from lastmodified", async () => {
    const { store, sync, atera, advance } = setup([ticket(1), ticket(2)]);
    await sync.tick();
    atera.state.modified = [ticket(2, { TicketStatus: "Resolved", TicketResolvedDate: "2026-10-01T11:00:00" }), ticket(3)];
    advance(6 * 60_000);
    await sync.tick();
    expect(store.count()).toBe(3);
    expect(store.query("WHERE id = ?", [2])[0]!.status).toBe("Resolved");
    const call = atera.calls.find((c) => c.startsWith("/api/v3/tickets/lastmodified"))!;
    // Cursor minus the 10 min overlap.
    expect(decodeURIComponent(call)).toContain("date=2026-10-01T09:50:00.000Z");
  });

  it("removes deleted tickets only after Atera confirms with a 404", async () => {
    const { store, sync, atera, advance } = setup([ticket(1), ticket(2), ticket(3)]);
    await sync.tick();
    atera.state.tickets.delete(2);
    advance(61 * 60_000); // next full run is due (default 60 min)
    await sync.tick();
    expect(store.query("ORDER BY id", []).map((r) => r.id)).toEqual([1, 3]);
    expect(atera.calls).toContain("/api/v3/tickets/2?");
  });

  it("shrinks the page size around a page too heavy to download, then grows back", async () => {
    const tickets = Array.from({ length: 300 }, (_, i) => ticket(i + 1));
    const { store, sync, atera } = setup(tickets);
    atera.state.heavyId = 77;
    const logs: string[] = [];
    (sync as unknown as { opts: { log: (m: string) => void } }).opts.log = (m) => logs.push(m);
    await sync.tick();
    expect(sync.status().lastError).toBeNull();
    expect(sync.status().building).toBe(false);
    expect(store.count()).toBe(300);
    expect(logs.some((l) => l.includes("retrying with pages of 25"))).toBe(true);
    expect(logs.some((l) => l.includes("retrying with pages of 10"))).toBe(true);
    // Back to pages of 50 at the end.
    const sizes = atera.calls.filter((c) => c.startsWith("/api/v3/tickets?")).map((c) => new URLSearchParams(c.split("?")[1]).get("itemsInPage"));
    expect(sizes.at(-1)).toBe("50");
  });

  it("skips a ticket that cannot be downloaded even alone", async () => {
    const { store, sync, atera } = setup(Array.from({ length: 60 }, (_, i) => ticket(i + 1)));
    atera.state.heavyId = 7;
    atera.state.heavyMaxSize = 0;
    await sync.tick();
    expect(sync.status().building).toBe(false);
    expect(store.count()).toBe(59);
    expect(store.query("WHERE id = 7", [])).toHaveLength(0);
  });

  it("resumes a 0.2.1 run from its page counter", async () => {
    const tickets = Array.from({ length: 120 }, (_, i) => ticket(i + 1));
    const { store, sync, atera } = setup(tickets);
    store.setMeta("full_run_id", "old-run");
    store.setMeta("full_run_started_at", "2026-10-01T09:00:00.000Z");
    store.setMeta("full_next_page", 2);
    expect(sync.status().fullProgress).toEqual({ page: 2, totalPages: null });
    await sync.tick();
    const firstCall = atera.calls.find((c) => c.startsWith("/api/v3/tickets?"))!;
    expect(firstCall).toContain("page=2&itemsInPage=50");
    expect(sync.status().building).toBe(false);
    expect(store.meta("full_next_page")).toBeNull();
  });

  it("lets only one process sync a shared index", async () => {
    const a = setup([ticket(1), ticket(2)]);
    const client = new AteraClient(
      { apiKey: "k", baseUrl: "https://atera.test/api/v3", timeoutMs: 1000 },
      a.atera.fetchImpl,
      async () => {},
    );
    // Second process on the same database.
    const other = new TicketSync(a.store, client, { log: () => {}, now: a.now, sleep: async () => {} });
    await a.sync.tick();
    const calls = a.atera.calls.length;
    await other.tick();
    expect(a.atera.calls.length).toBe(calls);
    a.sync.stop(); // releases the lease
    a.advance(61 * 60_000);
    await other.tick();
    expect(a.atera.calls.length).toBeGreaterThan(calls);
  });

  it("freshen() runs an incremental when the data is stale", async () => {
    const { sync, atera, advance } = setup([ticket(1)]);
    await sync.tick();
    const before = atera.calls.length;
    await sync.freshen(60_000);
    expect(atera.calls.length).toBe(before); // fresh enough
    advance(2 * 60_000);
    await sync.freshen(60_000);
    expect(atera.calls.length).toBe(before + 1);
  });
});

suite("stats helpers", () => {
  it("parses date bounds in the configured time zone", () => {
    expect(parseBound("2026-09-01", "UTC", "start")).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(parseBound("2026-09-01", "UTC", "end")).toBe(Date.parse("2026-09-02T00:00:00Z"));
    expect(parseBound("2026-09", "Europe/Paris", "start")).toBe(Date.parse("2026-08-31T22:00:00Z"));
    expect(parseBound("2026-12", "Europe/Paris", "end")).toBe(Date.parse("2026-12-31T23:00:00Z"));
    expect(parseBound("2025", "UTC", "end")).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(() => parseBound("last week", "UTC", "start")).toThrow(/Invalid date/);
  });

  it("computes period keys, including ISO weeks", () => {
    const ms = Date.parse("2026-01-01T23:30:00Z");
    expect(periodKey(ms, "day", "UTC")).toBe("2026-01-01");
    expect(periodKey(ms, "day", "Europe/Paris")).toBe("2026-01-02");
    expect(periodKey(Date.parse("2027-01-01T12:00:00Z"), "week", "UTC")).toBe("2026-W53");
    expect(periodKey(ms, "month", "UTC")).toBe("2026-01");
  });

  it("quantile interpolates", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.9)).toBe(10);
  });

  it("filters and aggregates", () => {
    const store = openStoreWith(new DatabaseSync(":memory:"));
    const rows = [
      ticket(1, { TechnicianContactID: 7, TechnicianFullName: "Jean", TicketStatus: "Resolved", TicketResolvedDate: "2026-09-01T10:00:00" }),
      ticket(2, { TechnicianContactID: 7, TechnicianFullName: "Jean", TicketStatus: "Closed", TicketResolvedDate: "2026-09-01T12:00:00" }),
      ticket(3, { TechnicianContactID: 8, TechnicianFullName: "Paul", TicketCreatedDate: "2026-10-05T08:00:00" }),
      ticket(4, { TicketTitle: "Printer 50% broken", CustomerID: 2, CustomerName: "Globex" }),
    ].map((t) => ticketToRow(t, 1, null)!);
    store.upsert(rows);

    const sept = buildWhere({ createdFrom: "2026-09", createdTo: "2026-09" }, "UTC");
    expect(store.query(sept.where, sept.params).map((r) => r.id).sort()).toEqual([1, 2, 4]);

    const open = buildWhere({ open: true }, "UTC");
    expect(store.query(open.where, open.params).map((r) => r.id).sort()).toEqual([3, 4]);

    const like = buildWhere({ query: "50%" }, "UTC");
    expect(store.query(like.where, like.params).map((r) => r.id)).toEqual([4]);

    const multi = buildWhere({ status: ["resolved", "CLOSED"], technicianName: "jea" }, "UTC");
    expect(store.query(multi.where, multi.params)).toHaveLength(2);

    const all = store.query("", []);
    const byTech = aggregate(all, "technician", "UTC", 25);
    expect(byTech.total).toMatchObject({ count: 4, open: 2, resolved: 2 });
    expect(byTech.total.resolutionHours).toEqual({ avg: 3, median: 3, p90: 3.8 });
    expect(byTech.groups[0]).toMatchObject({ key: "7", label: "Jean", count: 2 });
    expect(byTech.groups.map((g) => g.key)).toContain("(unassigned)");

    const byMonth = aggregate(all, "created_month", "UTC", 1);
    expect(byMonth.groups).toEqual([expect.objectContaining({ key: "2026-10", count: 1 })]);
    expect(byMonth.otherGroups).toEqual({ groups: 1, count: 3 });
  });
});
