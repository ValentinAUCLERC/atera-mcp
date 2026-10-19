import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AteraApiError, AteraClient } from "./client.js";
import type { AccessLevel, Config } from "./config.js";
import { agentTools, alertTools } from "./tools/agents.js";
import type { ToolAccess, ToolDefinition } from "./tools/common.js";
import { contactTools, customerTools } from "./tools/customers.js";
import { otherTools } from "./tools/other.js";
import { ticketTools } from "./tools/tickets.js";

export const SERVER_NAME = "atera-mcp";
export const SERVER_VERSION = "0.1.0";

export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...ticketTools,
  ...customerTools,
  ...contactTools,
  ...agentTools,
  ...alertTools,
  ...otherTools,
];

const ALLOWED: Record<AccessLevel, ReadonlySet<ToolAccess>> = {
  read: new Set(["read"]),
  write: new Set(["read", "write"]),
  full: new Set(["read", "write", "delete"]),
};

export function selectTools(config: Pick<Config, "access" | "toolsets">): ToolDefinition[] {
  return ALL_TOOLS.filter(
    (tool) => ALLOWED[config.access].has(tool.access) && config.toolsets.has(tool.toolset),
  );
}

const INSTRUCTIONS = `Atera RMM/PSA (API v3).
- IDs: find a customer with find_customers, a contact with find_contacts, a machine with find_agents or get_agent_by_machine, then use the numeric IDs in other tools.
- List tools return a summary and are paginated (page, itemsInPage ≤ 50, hasMore). Pass full=true only when you need every field.
- find_* tools scan pages client-side: if "truncated" is true, there may be more matches beyond the scanned pages.
- Create, update, comment and delete tools change real customer data: use them only when the user explicitly asks.`;

export function createServer(config: Config, client = new AteraClient(config)): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  for (const tool of selectTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === "read",
          destructiveHint: tool.access === "delete",
          idempotentHint: tool.access === "read" || tool.idempotent === true,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => runTool(tool, args, client),
    );
  }
  return server;
}

export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  client: AteraClient,
): Promise<CallToolResult> {
  try {
    const data = await tool.handler(args ?? {}, client);
    return { content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(errorEnvelope(err)) }] };
  }
}

export function errorEnvelope(err: unknown): {
  error: { code: string; message: string; status?: number; retryable: boolean };
} {
  if (err instanceof AteraApiError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        status: err.status || undefined,
        retryable: err.retryable,
      },
    };
  }
  return {
    error: {
      code: "invalid_argument",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    },
  };
}
