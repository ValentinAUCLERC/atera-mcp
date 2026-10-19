import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, TOOLSETS } from "../src/config.js";
import { compact, summarize, toListResult } from "../src/format.js";

describe("compact", () => {
  it("drops null, empty strings, empty arrays and empty objects but keeps false and 0", () => {
    expect(
      compact({ a: null, b: "", c: [], d: {}, e: false, f: 0, g: { h: null, i: "x" }, j: [null, 1] }),
    ).toEqual({ e: false, f: 0, g: { i: "x" }, j: [1] });
  });
});

describe("summarize", () => {
  it("keeps only the listed fields and truncates long strings", () => {
    const out = summarize({ A: 1, B: "x".repeat(400), C: "drop" }, ["A", "B"]) as Record<string, string>;
    expect(Object.keys(out)).toEqual(["A", "B"]);
    expect(out.B!.length).toBe(301);
  });
});

describe("toListResult", () => {
  it("maps Atera's envelope", () => {
    const res = toListResult(
      { items: [{ A: 1, B: 2 }], page: 1, totalPages: 3, totalItemCount: 55 },
      1,
      ["A"],
    );
    expect(res).toEqual({ items: [{ A: 1 }], page: 1, totalPages: 3, totalItems: 55, hasMore: true });
  });

  it("tolerates an empty or null response", () => {
    expect(toListResult(null, 2, null)).toEqual({
      items: [],
      page: 2,
      totalPages: null,
      totalItems: null,
      hasMore: false,
    });
  });
});

describe("loadConfig", () => {
  it("requires an API key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("defaults to read-only access and every toolset", () => {
    const c = loadConfig({ ATERA_API_KEY: "k" });
    expect(c.access).toBe("read");
    expect([...c.toolsets]).toEqual([...TOOLSETS]);
    expect(c.baseUrl).toBe("https://app.atera.com/api/v3");
  });

  it("parses access and toolsets, and rejects unknown values", () => {
    const c = loadConfig({ ATERA_API_KEY: "k", ATERA_ACCESS: "WRITE", ATERA_TOOLSETS: "tickets, customers" });
    expect(c.access).toBe("write");
    expect([...c.toolsets]).toEqual(["tickets", "customers"]);
    expect(() => loadConfig({ ATERA_API_KEY: "k", ATERA_ACCESS: "admin" })).toThrow(/ATERA_ACCESS/);
    expect(() => loadConfig({ ATERA_API_KEY: "k", ATERA_TOOLSETS: "tickets,nope" })).toThrow(/nope/);
  });
});
