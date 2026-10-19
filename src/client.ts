import type { Config } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type QueryValue = string | number | boolean | undefined | null;

export type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Overrides the client timeout (whole request, body included). */
  timeoutMs?: number;
  /** Max retries for this request (default 2). */
  retries?: number;
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 20_000;
const ERROR_BODY_MAX_CHARS = 500;

export type ErrorCode =
  | "invalid_argument"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "network_error";

export class AteraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AteraApiError";
  }
}

export function classifyStatus(status: number): { code: ErrorCode; retryable: boolean } {
  if (status === 0) return { code: "network_error", retryable: true };
  if (status === 401) return { code: "unauthorized", retryable: false };
  if (status === 403) return { code: "forbidden", retryable: false };
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "upstream_error", retryable: true };
  return { code: "invalid_argument", retryable: false };
}

/** Current Atera API tokens are JWTs (sent as Bearer); legacy keys go in X-API-KEY. */
export function isJwt(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 3 &&
    parts[0]!.startsWith("eyJ") &&
    parts.every((p) => /^[A-Za-z0-9_-]+={0,2}$/.test(p))
  );
}

export class AteraClient {
  private readonly authHeaders: Record<string, string>;

  constructor(
    private readonly config: Pick<Config, "apiKey" | "baseUrl" | "timeoutMs">,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.authHeaders = isJwt(config.apiKey)
      ? { Authorization: `Bearer ${config.apiKey}` }
      : { "X-API-KEY": config.apiKey };
  }

  get<T = unknown>(
    path: string,
    query?: Record<string, QueryValue>,
    options: Pick<RequestOptions, "timeoutMs" | "retries"> = {},
  ): Promise<T> {
    return this.request<T>("GET", path, { ...options, query });
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path, {});
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      ...this.authHeaders,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const maxRetries = options.retries ?? MAX_RETRIES;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let parsed: unknown;
      try {
        // The timeout covers the body too: a slow download must not hang forever.
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) parsed = await parseBody(response);
      } catch (err) {
        const error = new AteraApiError(
          0,
          "network_error",
          `${method} ${path} failed: ${describeFetchError(err)}`,
          true,
        );
        // A write may have reached Atera before the connection dropped: never replay it.
        if (method === "GET" && attempt < maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      }

      if (response.ok) return parsed as T;

      const { code, retryable } = classifyStatus(response.status);
      // 429 means the request was rejected before processing, so it is safe to replay
      // for every method; 5xx is only replayed for idempotent reads.
      const canRetry =
        attempt < maxRetries &&
        (response.status === 429 || (method === "GET" && response.status >= 500));
      if (canRetry) {
        await this.sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }
      const detail = await readErrorDetail(response);
      throw new AteraApiError(
        response.status,
        code,
        `Atera returned HTTP ${response.status} for ${method} ${path}${detail ? `: ${detail}` : ""}`,
        retryable,
      );
    }
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  if (text === "") return "";
  let detail = text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const msg = parsed.Message ?? parsed.message ?? parsed.error ?? parsed.title;
    if (typeof msg === "string" && msg.trim() !== "") detail = msg;
  } catch {
    // keep the raw text
  }
  return detail.length > ERROR_BODY_MAX_CHARS ? `${detail.slice(0, ERROR_BODY_MAX_CHARS)}…` : detail;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
  return null;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError" || /aborted due to timeout/i.test(err.message)) {
      return "request timed out";
    }
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return cause ? `${err.message} (${cause})` : err.message;
  }
  return String(err);
}
