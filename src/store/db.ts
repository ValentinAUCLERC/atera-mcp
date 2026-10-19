import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** One row per ticket: metadata only, no comment text. */
export type TicketRow = {
  id: number;
  number: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  impact: string | null;
  type: string | null;
  source: string | null;
  customer_id: number | null;
  customer_name: string | null;
  enduser_id: number | null;
  enduser_email: string | null;
  enduser_name: string | null;
  technician_id: number | null;
  technician_name: string | null;
  technician_email: string | null;
  contract_id: number | null;
  created_at: number | null;
  resolved_at: number | null;
  first_response_at: number | null;
  first_response_due: number | null;
  close_due: number | null;
  last_enduser_comment_at: number | null;
  last_technician_comment_at: number | null;
  onsite_minutes: number | null;
  offsite_minutes: number | null;
  total_minutes: number | null;
  synced_at: number;
  seen_run: string | null;
};

const COLUMNS = [
  "id",
  "number",
  "title",
  "status",
  "priority",
  "impact",
  "type",
  "source",
  "customer_id",
  "customer_name",
  "enduser_id",
  "enduser_email",
  "enduser_name",
  "technician_id",
  "technician_name",
  "technician_email",
  "contract_id",
  "created_at",
  "resolved_at",
  "first_response_at",
  "first_response_due",
  "close_due",
  "last_enduser_comment_at",
  "last_technician_comment_at",
  "onsite_minutes",
  "offsite_minutes",
  "total_minutes",
  "synced_at",
  "seen_run",
] as const satisfies readonly (keyof TicketRow)[];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  number TEXT, title TEXT, status TEXT, priority TEXT, impact TEXT, type TEXT, source TEXT,
  customer_id INTEGER, customer_name TEXT,
  enduser_id INTEGER, enduser_email TEXT, enduser_name TEXT,
  technician_id INTEGER, technician_name TEXT, technician_email TEXT,
  contract_id INTEGER,
  created_at INTEGER, resolved_at INTEGER,
  first_response_at INTEGER, first_response_due INTEGER, close_due INTEGER,
  last_enduser_comment_at INTEGER, last_technician_comment_at INTEGER,
  onsite_minutes INTEGER, offsite_minutes INTEGER, total_minutes INTEGER,
  synced_at INTEGER NOT NULL,
  seen_run TEXT
);
CREATE INDEX IF NOT EXISTS tickets_created ON tickets(created_at);
CREATE INDEX IF NOT EXISTS tickets_resolved ON tickets(resolved_at);
CREATE INDEX IF NOT EXISTS tickets_customer ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS tickets_technician ON tickets(technician_id);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const SCHEMA_VERSION = "1";

/**
 * Atera returns dates such as "2026-09-12T08:14:22" (no offset) or with "Z".
 * Dates without an offset are UTC.
 */
export function parseAteraDate(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const v = value.trim();
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v);
  const ms = Date.parse(hasOffset || !v.includes("T") ? v : `${v}Z`);
  if (!Number.isFinite(ms)) return null;
  // Atera uses 0001-01-01 for "no date".
  return ms < Date.UTC(1990, 0, 1) ? null : ms;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function ticketToRow(t: Record<string, unknown>, syncedAt: number, seenRun: string | null): TicketRow | null {
  const id = num(t.TicketID);
  if (id === null) return null;
  const first = str(t.EndUserFirstName);
  const last = str(t.EndUserLastName);
  return {
    id,
    number: str(t.TicketNumber) ?? (typeof t.TicketNumber === "number" ? String(t.TicketNumber) : null),
    title: str(t.TicketTitle),
    status: str(t.TicketStatus),
    priority: str(t.TicketPriority),
    impact: str(t.TicketImpact),
    type: str(t.TicketType),
    source: str(t.TicketSource),
    customer_id: num(t.CustomerID),
    customer_name: str(t.CustomerName),
    enduser_id: num(t.EndUserID),
    enduser_email: str(t.EndUserEmail),
    enduser_name: [first, last].filter(Boolean).join(" ") || null,
    technician_id: num(t.TechnicianContactID),
    technician_name: str(t.TechnicianFullName),
    technician_email: str(t.TechnicianEmail),
    contract_id: num(t.ContractID),
    created_at: parseAteraDate(t.TicketCreatedDate),
    resolved_at: parseAteraDate(t.TicketResolvedDate),
    first_response_at: parseAteraDate(t.TechnicianFirstCommentDate),
    first_response_due: parseAteraDate(t.FirstResponseDueDate),
    close_due: parseAteraDate(t.ClosedTicketDueDate),
    last_enduser_comment_at: parseAteraDate(t.LastEndUserCommentTimestamp),
    last_technician_comment_at: parseAteraDate(t.LastTechnicianCommentTimestamp),
    onsite_minutes: num(t.OnSiteDurationMinutes),
    offsite_minutes: num(t.OffSiteDurationMinutes),
    total_minutes: num(t.TotalDurationMinutes),
    synced_at: syncedAt,
    seen_run: seenRun,
  };
}

export type TicketStore = ReturnType<typeof openStoreWith>;

/** `node:sqlite` needs Node >= 22.13: loaded lazily so the live tools still run on Node 20. */
export async function openStore(cacheDir: string, accountKey: string): Promise<TicketStore> {
  silenceSqliteWarning();
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `atera-${createHash("sha256").update(accountKey).digest("hex").slice(0, 16)}.sqlite`);
  return openStoreWith(new DatabaseSync(file));
}

export function openStoreWith(db: DatabaseSync) {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMetaStmt = db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const delMeta = db.prepare("DELETE FROM meta WHERE key = ?");

  if ((getMeta.get("schema_version") as { value?: string } | undefined)?.value !== SCHEMA_VERSION) {
    setMetaStmt.run("schema_version", SCHEMA_VERSION);
  }

  const upsertStmt = db.prepare(
    `INSERT INTO tickets(${COLUMNS.join(",")}) VALUES(${COLUMNS.map(() => "?").join(",")})
     ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter((c) => c !== "id" && c !== "seen_run")
       .map((c) => `${c} = excluded.${c}`)
       .join(", ")}, seen_run = COALESCE(excluded.seen_run, tickets.seen_run)`,
  );

  return {
    db,

    meta(key: string): string | null {
      return (getMeta.get(key) as { value?: string } | undefined)?.value ?? null;
    },

    setMeta(key: string, value: string | number | null): void {
      if (value === null) delMeta.run(key);
      else setMetaStmt.run(key, String(value));
    },

    upsert(rows: TicketRow[]): void {
      if (rows.length === 0) return;
      db.exec("BEGIN");
      try {
        for (const row of rows) upsertStmt.run(...COLUMNS.map((c) => row[c]));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    /**
     * Sync lease: only one process syncs a given index (an orphaned process after a config
     * change, or two hosts sharing the file). Returns true if `owner` holds the lease until now+ttl.
     */
    tryLease(owner: string, now: number, ttlMs: number): boolean {
      db.exec("BEGIN IMMEDIATE");
      try {
        const raw = (getMeta.get("sync_lease") as { value?: string } | undefined)?.value;
        const lease = raw ? (JSON.parse(raw) as { owner: string; until: number }) : null;
        if (lease && lease.owner !== owner && lease.until > now) {
          db.exec("COMMIT");
          return false;
        }
        setMetaStmt.run("sync_lease", JSON.stringify({ owner, until: now + ttlMs }));
        db.exec("COMMIT");
        return true;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    releaseLease(owner: string): void {
      const raw = (getMeta.get("sync_lease") as { value?: string } | undefined)?.value;
      if (raw && (JSON.parse(raw) as { owner: string }).owner === owner) delMeta.run("sync_lease");
    },

    count(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    },

    /** Tickets a completed full run did not see, and that were not refreshed since it started. */
    unseenSince(runId: string, runStartedAt: number): number[] {
      return (
        db
          .prepare("SELECT id FROM tickets WHERE (seen_run IS NULL OR seen_run <> ?) AND synced_at < ?")
          .all(runId, runStartedAt) as { id: number }[]
      ).map((r) => r.id);
    },

    remove(ids: number[]): void {
      if (ids.length === 0) return;
      const stmt = db.prepare("DELETE FROM tickets WHERE id = ?");
      db.exec("BEGIN");
      try {
        for (const id of ids) stmt.run(id);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    query(where: string, params: (string | number)[], columns = "*"): TicketRow[] {
      return db.prepare(`SELECT ${columns} FROM tickets ${where}`).all(...params) as TicketRow[];
    },

    close(): void {
      db.close();
    },
  };
}

let silenced = false;
function silenceSqliteWarning(): void {
  if (silenced) return;
  silenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
