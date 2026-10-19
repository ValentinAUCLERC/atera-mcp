import { describe, expect, it, vi } from "vitest";
import { AteraApiError, AteraClient, isJwt, type FetchLike } from "../src/client.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: FetchLike, apiKey = "legacy-key") {
  const sleep = vi.fn(async () => {});
  const client = new AteraClient({ apiKey, baseUrl: "https://atera.test/api/v3", timeoutMs: 1000 }, fetchImpl, sleep);
  return { client, sleep };
}

describe("isJwt", () => {
  it("detects JWT-shaped tokens", () => {
    expect(isJwt(JWT)).toBe(true);
    expect(isJwt("a1b2c3d4e5f6")).toBe(false);
    expect(isJwt("eyJ.x")).toBe(false);
  });
});

describe("AteraClient", () => {
  it("sends legacy keys in X-API-KEY and builds the query string", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, { ok: 1 }));
    const { client } = makeClient(fetchImpl);
    await client.get("/tickets", { page: 2, ticketStatus: "Open", customerId: undefined, empty: "" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://atera.test/api/v3/tickets?page=2&ticketStatus=Open");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-KEY"]).toBe("legacy-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends JWT keys as a Bearer token only", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200, {}));
    const { client } = makeClient(fetchImpl, JWT);
    await client.get("/account");
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(headers["X-API-KEY"]).toBeUndefined();
  });

  it("returns null for empty bodies and sends JSON bodies", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("", { status: 200 }));
    const { client } = makeClient(fetchImpl);
    expect(await client.post("/tickets", { TicketTitle: "x" })).toBeNull();
    const init = fetchImpl.mock.calls[0]![1];
    expect(init.body).toBe('{"TicketTitle":"x"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("retries GET on 5xx then succeeds", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    const { client, sleep } = makeClient(fetchImpl);
    expect(await client.get("/agents")).toEqual({ items: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("honours Retry-After on 429, for writes too", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "3" }))
      .mockResolvedValueOnce(jsonResponse(200, { ActionID: "1" }));
    const { client, sleep } = makeClient(fetchImpl);
    await client.post("/tickets", {});
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("never replays a write after a 5xx or a network error", async () => {
    const fetch5xx = vi.fn<FetchLike>(async () => jsonResponse(500, { Message: "boom" }));
    await expect(makeClient(fetch5xx).client.post("/tickets", {})).rejects.toMatchObject({
      status: 500,
      code: "upstream_error",
    });
    expect(fetch5xx).toHaveBeenCalledTimes(1);

    const fetchNet = vi.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(makeClient(fetchNet).client.post("/tickets", {})).rejects.toMatchObject({ code: "network_error" });
    expect(fetchNet).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after 2 retries", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(502, {}));
    await expect(makeClient(fetchImpl).client.get("/alerts")).rejects.toBeInstanceOf(AteraApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("maps errors with Atera's message and does not retry 4xx", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(401, { Message: "Invalid API key" }));
    const err = (await makeClient(fetchImpl).client.get("/account").catch((e: unknown) => e)) as AteraApiError;
    expect(err).toBeInstanceOf(AteraApiError);
    expect(err.code).toBe("unauthorized");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Invalid API key");
    expect(err.message).not.toContain("legacy-key");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
