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
  /** Pause after a failed run before trying again. */
  errorBackoffMs: number;
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
  fullPage: "full_next_page",
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
      if (this.lastFailureAt !== null && now - this.lastFailureAt < this.opts.errorBackoffMs) return;
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
    const page = this.store.meta(M.fullPage);
    const total = this.store.meta(M.fullTotalPages);
    const candidates = [lastInc, lastFull].filter((v): v is string => v !== null).sort();
    return {
      ticketsIndexed: this.store.count(),
      building: lastFull === null,
      running: this.running,
      fullProgress:
        this.store.meta(M.fullRunId) !== null
          ? { page: Number(page ?? 1), totalPages: total !== null ? Number(total) : null }
          : null,
      lastIncrementalAt: lastInc,
      lastFullAt: lastFull,
      lastError: this.store.meta(M.lastError),
      dataAsOf: candidates.at(-1) ?? null,
    };
  }

  /** Full pass over /tickets. Resumes from the saved page after a restart. */
  async fullRun(): Promise<void> {
    let runId = this.store.meta(M.fullRunId);
    let started = toMs(this.store.meta(M.fullRunStarted));
    let page = Number(this.store.meta(M.fullPage) ?? 1);
    if (runId === null || started === null) {
      runId = randomUUID();
      started = this.opts.now();
      page = 1;
      this.store.setMeta(M.fullRunId, runId);
      this.store.setMeta(M.fullRunStarted, new Date(started).toISOString());
      this.store.setMeta(M.fullPage, 1);
      this.opts.log("full sync started");
    } else {
      this.opts.log(`full sync resumed at page ${page}`);
    }
    const run = runId;
    const runStarted = started;

    for (;;) {
      const data = await this.fetchPage("/tickets", { page, itemsInPage: MAX_ITEMS_IN_PAGE });
      const items = Array.isArray(data?.items) ? data!.items : [];
      const now = this.opts.now();
      this.store.upsert(rows(items, now, run));
      const totalPages = typeof data?.totalPages === "number" ? data.totalPages : null;
      if (totalPages !== null) this.store.setMeta(M.fullTotalPages, totalPages);
      const last = totalPages !== null ? page >= totalPages : items.length < MAX_ITEMS_IN_PAGE;
      if (last || items.length === 0) break;
      page++;
      this.store.setMeta(M.fullPage, page);
    }

    await this.removeDeleted(run, runStarted);
    // Whatever changed during the run is caught by the next incremental, which starts from here.
    const startedIso = new Date(runStarted).toISOString();
    this.store.setMeta(M.lastFull, new Date(this.opts.now()).toISOString());
    if ((this.store.meta(M.lastIncremental) ?? "") < startedIso) {
      this.store.setMeta(M.lastIncremental, startedIso);
    }
    for (const key of [M.fullRunId, M.fullRunStarted, M.fullPage, M.fullTotalPages]) this.store.setMeta(key, null);
    this.opts.log(`full sync done: ${this.store.count()} tickets`);
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
        const ticket = await this.throttled(() => this.client.get<Record<string, unknown>>(`/tickets/${id}`));
        const row = ticket ? ticketToRow(ticket, this.opts.now(), runId) : null;
        if (row) this.store.upsert([row]);
      } catch (err) {
        if (err instanceof AteraApiError && err.status === 404) gone.push(id);
        else throw err;
      }
    }
    this.store.remove(gone);
    if (gone.length > 0) this.opts.log(`full sync: ${gone.length} deleted tickets removed`);
    if (candidates.length > checked.length) {
      this.opts.log(`full sync: ${candidates.length - checked.length} unseen tickets left for the next run`);
    }
  }

  private fetchPage(path: string, query: Record<string, string | number | boolean>): Promise<AteraPage | null> {
    return this.throttled(() => this.client.get<AteraPage | null>(path, query));
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
