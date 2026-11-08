import { createInterface } from "node:readline";
import type { Config } from "../config.js";
import type { Engine } from "../core/engine.js";
import { log } from "../util/log.js";
import { createMcpServer } from "./server.js";

/**
 * Serve MCP over stdin/stdout (newline-delimited JSON). Resolves when the
 * client closes stdin or the process is asked to stop.
 */
export async function serveStdio(engine: Engine, config: Config): Promise<void> {
  const send = (msg: unknown) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const server = createMcpServer({ engine, config, send });

  engine.start();
  log.info("MCP server ready on stdio");

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    // Not awaited: requests run concurrently; each response carries its id.
    void server.rpc.receive(line);
  });

  await new Promise<void>((resolve) => {
    lines.once("close", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  log.info("shutting down");
  lines.close();
  await engine.close();
}
