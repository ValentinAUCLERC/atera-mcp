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

  return {
    apiKey,
    baseUrl,
    timeoutMs,
    access: access as AccessLevel,
    toolsets,
  };
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
