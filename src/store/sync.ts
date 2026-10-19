import { randomUUID } from "node:crypto";
import { AteraApiError, type AteraClient } from "../client.js";
import { MAX_ITEMS_IN_PAGE, type AteraPage } from "../format.js";
import { ticketToRow, type TicketRow, type TicketStore } from "./db.js";

/** A sync holds the lease this long; renewed on every page. */
const LEASE_TTL_MS = 3 * 60_000;

export class LeaseLostError extends Error {}

export type SyncOptions = {
  /** Max Atera requests per minute used by the sync (Atera allows ~700 for the whole account). */
  requestsPerMinute: number;
  /** Incremental sync period. */
  incrementalMs: number;
  /** Full reconciliation period. */
  fullMs: number;
  /** Overlap applied to the incremental cursor (clock skew, time zones). */
  overlapMs: number;
  /** Max deletion candidates confirmed one by one after a full run. */
  maxDeleteChecks: number;
  /** Pause after a failed run before trying again (shorter while the index is being built). */
  errorBackoffMs: number;
  /** Timeout of one sync request, body included (ticket pages can be large). */
  requestTimeoutMs: number;
  /** Requests slower than this are logged with their size. */
  slowRequestMs: number;
  log: (msg: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  requestsPerMinute: 300,
  incrementalMs: 5 * 60_000,
  fullMs: 20 * 60_000,
  overlapMs: 10 * 60_000,
  maxDeleteChecks: 200,
  errorBackoffMs: 5 * 60_000,
  requestTimeoutMs: 120_000,
  slowRequestMs: 15_000,
  log: (msg) => console.error(`[atera-mcp] ${msg}`),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type SyncStatus = {
  ticketsIndexed: number;
  /** True until the first full sync has completed. */
  building: boolean;
  running: "full" | "incremental" | null;
  fullProgress: { page: number; totalPages: number | null } | null;
  lastIncrementalAt: string | null;
  lastFullAt: string | null;
  lastError: string | null;
  /** Freshness of the data: the most recent successful sync. */
  dataAsOf: string | null;
};

const M = {
  lastIncremental: "last_incremental_at",
  lastFull: "last_full_at",
  fullRunId: "full_run_id",
  fullRunStarted: "full_run_started_at",
  /** Legacy (0.2.0/0.2.1): next page of 50. Migrated to fullOffset. */
  fullPage: "full_next_page",
  fullOffset: "full_next_offset",
  fullTotal: "full_total_items",
  fullTotalPages: "full_total_pages",
  lastError: "last_error",
} as const;

/**
 * Keeps the local ticket index in sync with Atera:
 * - full run: walks /tickets page by page (resumable), then removes tickets that vanished;
 * - incremental: /tickets/lastmodified since the last run, minus an overlap.
 * One job at a time; requests are throttled to `requestsPerMinute`.
 */
export class TicketSync {
  private readonly opts: SyncOptions;
  private running: "full" | "incremental" | null = null;
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private lastRequestAt = 0;
  private lastFailureAt: number | null = null;
  private readonly owner = randomUUID();

  constructor(
    private readonly store: TicketStore,
    private readonly client: AteraClient,
    options: Partial<SyncOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SYNC_OPTIONS, ...options };
  }

  /** Starts the background loop: catch up now, then tick every minute. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.releaseLease(this.owner);
  }

  /** Runs whatever is due. Never throws (errors are recorded in the status). */
  tick(): Promise<void> {
    return this.enqueue(async () => {
      const now = this.opts.now();
      const building = this.store.meta(M.lastFull) === null;
      const backoff = building ? Math.min(this.opts.errorBackoffMs, 60_000) : this.opts.errorBackoffMs;
      if (this.lastFailureAt !== null && now - this.lastFailureAt < backoff) return;
      // Another process syncs this index: just read it.
      if (!this.store.tryLease(this.owner, now, LEASE_TTL_MS)) return;
      const lastFull = toMs(this.store.meta(M.lastFull));
      const lastInc = toMs(this.store.meta(M.lastIncremental));
      const resuming = this.store.meta(M.fullRunId) !== null;
      if (resuming || lastFull === null || now - lastFull >= this.opts.fullMs) {
        await this.guard("full", () => this.fullRun());
      } else if (lastInc === null || now - lastInc >= this.opts.incrementalMs) {
        await this.guard("incremental", () => this.incrementalRun());
      }
    });
  }

  /** Quick catch-up before answering a query, if the index is ready but a bit stale. */
  async freshen(maxAgeMs = 60_000): Promise<void> {
    if (this.running !== null || this.store.meta(M.lastFull) === null) return;
    const lastInc = toMs(this.store.meta(M.lastIncremental)) ?? 0;
    if (this.opts.now() - lastInc < maxAgeMs) return;
    if (!this.store.tryLease(this.owner, this.opts.now(), LEASE_TTL_MS)) return;
    await this.enqueue(() => this.guard("incremental", () => this.incrementalRun()));
  }

  status(): SyncStatus {
    const lastInc = this.store.meta(M.lastIncremental);
    const lastFull = this.store.meta(M.lastFull);
    const offset = this.fullOffset();
    const total = this.store.meta(M.fullTotal);
    const candidates = [lastInc, lastFull].filter((v): v is string => v !== null).sort();
    return {
      ticketsIndexed: this.store.count(),
      building: lastFull === null,
      running: this.running,
      fullProgress:
        this.store.meta(M.fullRunId) !== null
          ? {
              page: Math.floor(offset / MAX_ITEMS_IN_PAGE) + 1,
              totalPages: total !== null ? Math.max(1, Math.ceil(Number(total) / MAX_ITEMS_IN_PAGE)) : null,
            }
          : null,
      lastIncrementalAt: lastInc,
      lastFullAt: lastFull,
      lastError: this.store.meta(M.lastError),
      dataAsOf: candidates.at(-1) ?? null,
    };
  }

  /**
   * Full pass over /tickets, resumable. Progress is an offset (tickets already read), so the
   * page size can shrink when a page is too heavy to download in time (huge descriptions,
   * inline images) and grow back afterwards.
   */
  async fullRun(): Promise<void> {
    let runId = this.store.meta(M.fullRunId);
    let started = toMs(this.store.meta(M.fullRunStarted));
    let offset = this.fullOffset();
    if (runId === null || started === null) {
      runId = randomUUID();
      started = this.opts.now();
      offset = 0;
      this.store.setMeta(M.fullRunId, runId);
      this.store.setMeta(M.fullRunStarted, new Date(started).toISOString());
      this.store.setMeta(M.fullOffset, 0);
      this.opts.log("full sync started");
    } else {
      this.opts.log(`full sync resumed at ticket ${offset}`);
    }
    const run = runId;
    const runStarted = started;

    let cap = MAX_ITEMS_IN_PAGE;
    let okAtCap = 0;
    for (;;) {
      const size = pageSizeFor(offset, cap);
      let data: AteraPage | null;
      try {
        data = await this.fetchPage("/tickets", { page: offset / size + 1, itemsInPage: size }, 0);
      } catch (err) {
        const smaller = PAGE_SIZES.find((s) => s < size);
        if (err instanceof AteraApiError && err.code === "network_error" && smaller !== undefined) {
          this.opts.log(`full sync: ${size} tickets at ${offset} timed out, retrying with pages of ${smaller}`);
          cap = smaller;
          okAtCap = 0;
          continue;
        }
        if (err instanceof AteraApiError && err.code === "network_error" && size === 1) {
          // Even alone this ticket cannot be downloaded in time: skip it rather than block the index.
          this.opts.log(`full sync: ticket at position ${offset} cannot be downloaded in time, skipped`);
          offset += 1;
          this.store.setMeta(M.fullOffset, offset);
          continue;
        }
        throw err;
      }
      const items = Array.isArray(data?.items) ? data!.items : [];
      this.store.upsert(rows(items, this.opts.now(), run));
      const total = typeof data?.totalItemCount === "number" ? data.totalItemCount : null;
      if (total !== null) this.store.setMeta(M.fullTotal, total);
      offset += items.length;
      this.store.setMeta(M.fullOffset, offset);
      if (items.length < size || (total !== null && offset >= total)) break;
      // Grow back once a few small pages went through.
      if (cap < MAX_ITEMS_IN_PAGE && ++okAtCap >= 5) {
        cap = [...PAGE_SIZES].reverse().find((s) => s > cap) ?? MAX_ITEMS_IN_PAGE;
        okAtCap = 0;
      }
    }

    await this.removeDeleted(run, runStarted);
    // Whatever changed during the run is caught by the next incremental, which starts from here.
    const startedIso = new Date(runStarted).toISOString();
    this.store.setMeta(M.lastFull, new Date(this.opts.now()).toISOString());
    if ((this.store.meta(M.lastIncremental) ?? "") < startedIso) {
      this.store.setMeta(M.lastIncremental, startedIso);
    }
    for (const key of [M.fullRunId, M.fullRunStarted, M.fullPage, M.fullOffset, M.fullTotal, M.fullTotalPages]) {
      this.store.setMeta(key, null);
    }
    this.opts.log(`full sync done: ${this.store.count()} tickets`);
  }

  /** Tickets already read by the current full run (migrates the page counter of 0.2.0/0.2.1). */
  private fullOffset(): number {
    const offset = this.store.meta(M.fullOffset);
    if (offset !== null) return Number(offset);
    const legacyPage = this.store.meta(M.fullPage);
    return legacyPage !== null ? (Number(legacyPage) - 1) * MAX_ITEMS_IN_PAGE : 0;
  }

  /** Tickets modified since the last incremental (minus the overlap). */
  async incrementalRun(): Promise<void> {
    const since = toMs(this.store.meta(M.lastIncremental)) ?? toMs(this.store.meta(M.lastFull));
    if (since === null) return;
    const startedAt = this.opts.now();
    const date = new Date(since - this.opts.overlapMs).toISOString();
    let page = 1;
    let changed = 0;
    for (;;) {
      const data = await this.fetchPage("/tickets/lastmodified", {
        page,
        itemsInPage: MAX_ITEMS_IN_PAGE,
        date,
        includeComments: false,
      });
      const items = Array.isArray(data?.items) ? data!.items : [];
      this.store.upsert(rows(items, this.opts.now(), null));
      changed += items.length;
      const totalPages = typeof data?.totalPages === "number" ? data.totalPages : null;
      const last = totalPages !== null ? page >= totalPages : items.length < MAX_ITEMS_IN_PAGE;
      if (last || items.length === 0) break;
      page++;
    }
    this.store.setMeta(M.lastIncremental, new Date(startedAt).toISOString());
    if (changed > 0) this.opts.log(`incremental sync: ${changed} tickets updated`);
  }

  /**
   * A ticket missing from a full run is only removed once Atera confirms it is gone (404):
   * pages can shift while the run walks them, so "not seen" alone is not proof of deletion.
   */
  private async removeDeleted(runId: string, startedAt: number): Promise<void> {
    const candidates = this.store.unseenSince(runId, startedAt);
    if (candidates.length === 0) return;
    const checked = candidates.slice(0, this.opts.maxDeleteChecks);
    const gone: number[] = [];
    for (const id of checked) {
      try {
        const ticket = await this.throttled(() =>
          this.client.get<Record<string, unknown>>(`/tickets/${id}`, undefined, { timeoutMs: this.opts.requestTimeoutMs }),
        );
        const row = ticket ? ticketToRow(ticket, this.opts.now(), runId) : null;
        if (row) this.store.upsert([row]);
      } catch (err) {
        if (err instanceof AteraApiError && err.status === 404) gone.push(id);
        else if (err instanceof AteraApiError && err.code === "network_error") continue; // keep it, check next run
        else throw err;
      }
    }
    this.store.remove(gone);
    if (gone.length > 0) this.opts.log(`full sync: ${gone.length} deleted tickets removed`);
    if (candidates.length > checked.length) {
      this.opts.log(`full sync: ${candidates.length - checked.length} unseen tickets left for the next run`);
    }
  }

  private fetchPage(
    path: string,
    query: Record<string, string | number | boolean>,
    retries?: number,
  ): Promise<AteraPage | null> {
    return this.throttled(async () => {
      const t0 = this.opts.now();
      const data = await this.client.get<AteraPage | null>(path, query, {
        timeoutMs: this.opts.requestTimeoutMs,
        retries,
      });
      const ms = this.opts.now() - t0;
      if (ms >= this.opts.slowRequestMs) {
        const kb = Math.round(JSON.stringify(data ?? "").length / 1024);
        this.opts.log(`slow Atera page: ${path} page=${query.page} size=${query.itemsInPage} ${ms} ms, ~${kb} KB`);
      }
      return data;
    });
  }

  private async throttled<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.store.tryLease(this.owner, this.opts.now(), LEASE_TTL_MS)) {
      throw new LeaseLostError("another process took over the sync of this index");
    }
    const gap = 60_000 / this.opts.requestsPerMinute;
    const wait = this.lastRequestAt + gap - this.opts.now();
    if (wait > 0) await this.opts.sleep(wait);
    this.lastRequestAt = this.opts.now();
    return fn();
  }

  private async guard(kind: "full" | "incremental", fn: () => Promise<void>): Promise<void> {
    this.running = kind;
    try {
      await fn();
      this.lastFailureAt = null;
      this.store.setMeta(M.lastError, null);
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.opts.log(`${kind} sync stopped: ${err.message}`);
        return;
      }
      this.lastFailureAt = this.opts.now();
      const msg = `${kind} sync failed: ${err instanceof Error ? err.message : String(err)}`;
      this.store.setMeta(M.lastError, `${new Date(this.opts.now()).toISOString()} ${msg}`);
      this.opts.log(msg);
    } finally {
      this.running = null;
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }
}

/** Allowed page sizes, largest first. */
const PAGE_SIZES = [50, 25, 10, 5, 1] as const;

/** Largest page size ≤ cap that keeps `offset` on a page boundary. */
export function pageSizeFor(offset: number, cap: number): number {
  return PAGE_SIZES.find((s) => s <= cap && offset % s === 0) ?? 1;
}

function rows(items: Record<string, unknown>[], now: number, runId: string | null): TicketRow[] {
  return items
    .map((item) => (item && typeof item === "object" ? ticketToRow(item, now, runId) : null))
    .filter((r): r is TicketRow => r !== null);
}

function toMs(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
