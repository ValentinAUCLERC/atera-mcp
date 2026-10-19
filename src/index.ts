#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer, selectTools, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[atera-mcp] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel: logs go to stderr only.
  console.error(
    `[atera-mcp] v${SERVER_VERSION} ready on stdio — access=${config.access}, ${selectTools(config).length} tools`,
  );
}

main().catch((err) => {
  console.error("[atera-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
