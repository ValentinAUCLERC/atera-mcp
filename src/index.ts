#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AteraClient } from "./client.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { createServer, selectTools, SERVER_VERSION } from "./server.js";
import type { ToolContext } from "./tools/common.js";

const log = (msg: string) => console.error(`[atera-mcp] ${msg}`);

async function openIndex(config: Config, client: AteraClient): Promise<ToolContext> {
  if (!config.index) return { stats: null };
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new ConfigError(`ATERA_CACHE_DIR needs Node.js 22.13 or later (running ${process.versions.node}).`);
  }
  const { openStore } = await import("./store/db.js");
  const { TicketSync } = await import("./store/sync.js");
  const store = await openStore(config.index.cacheDir, `${config.baseUrl}|${config.apiKey}`);
  const sync = new TicketSync(store, client, {
    requestsPerMinute: config.index.requestsPerMinute,
    incrementalMs: config.index.incrementalMinutes * 60_000,
    fullMs: config.index.fullMinutes * 60_000,
    requestTimeoutMs: config.index.requestTimeoutMs,
    log,
  });
  sync.start();
  return { stats: { store, sync, timeZone: config.index.timeZone } };
}

async function main(): Promise<void> {
  let config;
  let ctx: ToolContext;
  const client = () => new AteraClient(config!);
  try {
    config = loadConfig();
    ctx = await openIndex(config, client());
  } catch (err) {
    if (err instanceof ConfigError) {
      log(err.message);
      process.exit(1);
    }
    throw err;
  }

  const server = createServer(config, client(), ctx);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel: logs go to stderr only.
  log(
    `v${SERVER_VERSION} ready on stdio — access=${config.access}, ${selectTools(config).length} tools` +
      (config.index ? `, ticket index in ${config.index.cacheDir}` : ""),
  );

  const shutdown = () => {
    ctx.stats?.sync.stop();
    ctx.stats?.store.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
