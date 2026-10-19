import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AteraClient, type FetchLike } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { readFileSync } from "node:fs";
import { ALL_TOOLS, createServer, selectTools, SERVER_VERSION } from "../src/server.js";

type Route = (url: URL, init: RequestInit) => unknown;

function fakeAtera(route: Route) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchImpl = vi.fn<FetchLike>(async (input, init) => {
    const url = new URL(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", url, body });
    const result = route(url, init);
    if (result instanceof Response) return result;
    return new Response(result === undefined ? "" : JSON.stringify(result), { status: 200 });
  });
  return { fetchImpl, calls };
}

const clients: Client[] = [];

async function connect(env: Record<string, string>, route: Route) {
  const config = loadConfig({ ATERA_API_KEY: "test-key", ATERA_BASE_URL: "https://atera.test/api/v3", ...env });
  const fake = fakeAtera(route);
  const server = createServer(config, new AteraClient(config, fake.fetchImpl, async () => {}));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return { client, ...fake };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, data: JSON.parse(res.content[0]!.text) };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("tool catalogue", () => {
  it("reports the package.json version", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("has unique names, a description and a toolset for every tool", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("filters by access level and toolset", () => {
    const base = loadConfig({ ATERA_API_KEY: "k" });
    const read = selectTools(base);
    expect(read.every((t) => t.access === "read")).toBe(true);

    const write = selectTools({ ...base, access: "write" });
    expect(write.some((t) => t.access === "write")).toBe(true);
    expect(write.some((t) => t.access === "delete")).toBe(false);

    const full = selectTools({ ...base, access: "full" });
    expect(full.length).toBe(ALL_TOOLS.length);

    const ticketsOnly = selectTools({ ...base, toolsets: new Set(["tickets"]) });
    expect(ticketsOnly.every((t) => t.toolset === "tickets")).toBe(true);
  });
});

describe("MCP server", () => {
  it("lists every allowed tool up front with annotations", async () => {
    const { client } = await connect({}, () => ({}));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_tickets");
    expect(names).not.toContain("create_ticket");
    expect(names).not.toContain("delete_ticket");
    const listTickets = tools.find((t) => t.name === "list_tickets")!;
    expect(listTickets.annotations?.readOnlyHint).toBe(true);
    expect(listTickets.inputSchema.properties).toHaveProperty("ticketStatus");
  });

  it("lists tickets as a compact summary", async () => {
    const { client, calls } = await connect({}, () => ({
      items: [{ TicketID: 7, TicketTitle: "Printer", TicketStatus: "Open", FirstComment: "long text", CustomerName: null }],
      page: 1,
      totalPages: 1,
      totalItemCount: 1,
    }));
    const { isError, data } = await call(client, "list_tickets", { ticketStatus: "Open", customerId: 3 });
    expect(isError).toBe(false);
    expect(data).toEqual({
      items: [{ TicketID: 7, TicketTitle: "Printer", TicketStatus: "Open" }],
      page: 1,
      totalPages: 1,
      totalItems: 1,
      hasMore: false,
    });
    expect(calls[0]!.url.pathname).toBe("/api/v3/tickets");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      ticketStatus: "Open",
      customerId: "3",
      page: "1",
      itemsInPage: "20",
    });
  });

  it("find_customers scans pages until it finds enough matches", async () => {
    const { client, calls } = await connect({}, (url) => {
      const page = Number(url.searchParams.get("page"));
      const items = Array.from({ length: 50 }, (_, i) => ({
        CustomerID: page * 100 + i,
        CustomerName: page === 2 && i === 5 ? "ACME Industries" : `Customer ${page}-${i}`,
      }));
      return { items, page, totalPages: 4 };
    });
    const { data } = await call(client, "find_customers", { query: "acme", limit: 1 });
    expect(data.items).toEqual([{ CustomerID: 205, CustomerName: "ACME Industries" }]);
    expect(data.scannedPages).toBe(2);
    expect(data.truncated).toBe(true);
    expect(calls.every((c) => c.url.searchParams.get("itemsInPage") === "50")).toBe(true);
  });

  it("find_customers reports a complete scan", async () => {
    const { client } = await connect({}, () => ({ items: [{ CustomerID: 1, CustomerName: "Foo" }], page: 1, totalPages: 1 }));
    const { data } = await call(client, "find_customers", { query: "bar" });
    expect(data).toEqual({ items: [], scannedPages: 1, totalPages: 1, truncated: false });
  });

  it("list_agents switches to the per-customer endpoint", async () => {
    const { client, calls } = await connect({}, () => ({ items: [] }));
    await call(client, "list_agents", { customerId: 12 });
    expect(calls[0]!.url.pathname).toBe("/api/v3/agents/customer/12");
  });

  it("returns API errors as a JSON envelope with isError", async () => {
    const { client } = await connect({}, () =>
      new Response(JSON.stringify({ Message: "Ticket not found" }), { status: 404 }),
    );
    const { isError, data } = await call(client, "get_ticket", { ticketId: 99 });
    expect(isError).toBe(true);
    expect(data.error).toMatchObject({ code: "not_found", status: 404, retryable: false });
    expect(data.error.message).toContain("Ticket not found");
  });

  it("add_ticket_comment posts an internal technician comment by default", async () => {
    const { client, calls } = await connect({ ATERA_ACCESS: "write" }, () => undefined);
    const { data } = await call(client, "add_ticket_comment", { ticketId: 5, comment: "Called the user" });
    expect(data).toMatchObject({ added: true, ticketId: 5, internal: true });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url.pathname).toBe("/api/v3/tickets/5/comments");
    expect(calls[0]!.body).toEqual({
      CommentText: "Called the user",
      TechnicianCommentDetails: { IsInternal: true },
    });
  });

  it("update_ticket only sends the fields that were given", async () => {
    const { client, calls } = await connect({ ATERA_ACCESS: "write" }, () => ({ ActionID: "a1" }));
    await call(client, "update_ticket", { ticketId: 8, TicketStatus: "Resolved" });
    expect(calls[0]!.body).toEqual({ TicketStatus: "Resolved" });

    const empty = await call(client, "update_ticket", { ticketId: 8 });
    expect(empty.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("create_ticket requires an end user", async () => {
    const { client, calls } = await connect({ ATERA_ACCESS: "write" }, () => ({}));
    const res = await call(client, "create_ticket", { TicketTitle: "t", Description: "d" });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects invalid arguments before calling Atera", async () => {
    const { client, calls } = await connect({}, () => ({}));
    const res = (await client.callTool({ name: "get_ticket", arguments: { ticketId: "abc" } })) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("list_alerts filters severity client-side", async () => {
    const { client, calls } = await connect({}, () => ({
      items: [
        { AlertID: 1, Severity: "Critical", Title: "Disk" },
        { AlertID: 2, Severity: "Warning", Title: "CPU" },
      ],
      page: 1,
      totalPages: 1,
    }));
    const { data } = await call(client, "list_alerts", { status: "Open", severity: "Critical" });
    expect(data.items).toEqual([{ AlertID: 1, Severity: "Critical", Title: "Disk" }]);
    expect(calls[0]!.url.searchParams.get("alertStatus")).toBe("Open");
  });
});
