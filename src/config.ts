export const TOOLSETS = [
  "account",
  "customers",
  "contacts",
  "agents",
  "alerts",
  "tickets",
  "contracts",
  "knowledge",
  "billing",
  "customfields",
  "devices",
  "departments",
  "rates",
  "stats",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/**
 * read  = read tools only (default)
 * write = read + create/update
 * full  = read + create/update + delete
 */
export const ACCESS_LEVELS = ["read", "write", "full"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type Config = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  access: AccessLevel;
  toolsets: ReadonlySet<Toolset>;
  /** Max characters of one tool result (lists are trimmed to fit). */
  maxResultChars: number;
  /** Local ticket index for stats; null = disabled. */
  index: IndexConfig | null;
};

export type IndexConfig = {
  cacheDir: string;
  timeZone: string;
  requestsPerMinute: number;
  incrementalMinutes: number;
  fullMinutes: number;
  requestTimeoutMs: number;
};

export const DEFAULT_BASE_URL = "https://app.atera.com/api/v3";

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.ATERA_API_KEY ?? "").trim();
  if (apiKey === "") {
    throw new ConfigError(
      "ATERA_API_KEY is not set. Create an API key in Atera (Admin > API) and pass it as an environment variable.",
    );
  }

  const access = (env.ATERA_ACCESS ?? "read").trim().toLowerCase();
  if (!(ACCESS_LEVELS as readonly string[]).includes(access)) {
    throw new ConfigError(
      `ATERA_ACCESS must be one of ${ACCESS_LEVELS.join(", ")} (got "${access}").`,
    );
  }

  const toolsets = parseToolsets(env.ATERA_TOOLSETS);

  const timeoutMs = env.ATERA_TIMEOUT_MS ? Number(env.ATERA_TIMEOUT_MS) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("ATERA_TIMEOUT_MS must be a positive number of milliseconds.");
  }

  const baseUrl = (env.ATERA_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const maxResultChars = positive(env, "ATERA_MAX_RESULT_CHARS", 25_000);

  const cacheDir = (env.ATERA_CACHE_DIR ?? "").trim();
  let index: IndexConfig | null = null;
  if (cacheDir !== "") {
    const timeZone = (env.ATERA_TIMEZONE ?? "UTC").trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      throw new ConfigError(`ATERA_TIMEZONE "${timeZone}" is not a valid IANA time zone (e.g. Europe/Paris).`);
    }
    index = {
      cacheDir,
      timeZone,
      requestsPerMinute: Math.min(positive(env, "ATERA_SYNC_RPM", 300), 600),
      incrementalMinutes: positive(env, "ATERA_SYNC_INTERVAL_MIN", 5),
      fullMinutes: positive(env, "ATERA_SYNC_FULL_MIN", 60),
      requestTimeoutMs: positive(env, "ATERA_SYNC_TIMEOUT_MS", 120_000),
    };
  }

  return {
    apiKey,
    baseUrl,
    timeoutMs,
    access: access as AccessLevel,
    toolsets,
    maxResultChars,
    index,
  };
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number (got "${raw}").`);
  return n;
}

function parseToolsets(raw: string | undefined): ReadonlySet<Toolset> {
  if (raw === undefined || raw.trim() === "" || raw.trim().toLowerCase() === "all") {
    return new Set(TOOLSETS);
  }
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = wanted.filter((s) => !(TOOLSETS as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown toolset(s) in ATERA_TOOLSETS: ${unknown.join(", ")}. Valid values: ${TOOLSETS.join(", ")}.`,
    );
  }
  return new Set(wanted as Toolset[]);
}
