/** Ready-to-paste MCP setup for common clients (`init`, `start`, `config <client>`). */
import { realpathSync } from "node:fs";
import { sep } from "node:path";

export interface ServerCommand {
  command: string;
  args: string[];
}

export interface ClientSnippet {
  name: string;
  where: string;
  text: string;
}

const PUBLISHED: ServerCommand = { command: "npx", args: ["-y", "tiny-browse"] };

/**
 * How an agent should launch this tiny-browse. When it runs from an installed
 * package we use `npx -y tiny-browse`; from a source checkout (not on npm yet,
 * or a dev build) we point at this exact file with this exact node.
 */
export function serverCommand(scriptPath = process.argv[1], nodePath = process.execPath): ServerCommand {
  if (!scriptPath) return PUBLISHED;
  let real = scriptPath;
  try {
    real = realpathSync(scriptPath);
  } catch {
    // keep the path as given
  }
  if (real.includes(`${sep}node_modules${sep}tiny-browse${sep}`)) return PUBLISHED;
  return { command: nodePath, args: [real] };
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

export function clientSnippets(cmd: ServerCommand = serverCommand()): Record<string, ClientSnippet> {
  const server = { command: cmd.command, args: cmd.args };
  const shellCmd = [cmd.command, ...cmd.args].map(shellQuote).join(" ");
  return {
    "claude-code": {
      name: "Claude Code",
      where: "Run in a terminal:",
      text: `claude mcp add tiny-browse -- ${shellCmd}`,
    },
    "claude-desktop": {
      name: "Claude Desktop",
      where:
        "Add to claude_desktop_config.json (macOS: ~/Library/Application Support/Claude/, Windows: %APPDATA%\\Claude\\):",
      text: json({ mcpServers: { "tiny-browse": server } }),
    },
    cursor: {
      name: "Cursor",
      where: "Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project):",
      text: json({ mcpServers: { "tiny-browse": server } }),
    },
    vscode: {
      name: "VS Code",
      where: "Add to .vscode/mcp.json:",
      text: json({ servers: { "tiny-browse": { type: "stdio", ...server } } }),
    },
    codex: {
      name: "Codex CLI",
      where: "Add to ~/.codex/config.toml:",
      text: `[mcp_servers.tiny-browse]\ncommand = ${tomlString(cmd.command)}\nargs = [${cmd.args.map(tomlString).join(", ")}]`,
    },
    generic: {
      name: "Any MCP client (stdio)",
      where: "Most clients accept this shape:",
      text: json({ mcpServers: { "tiny-browse": server } }),
    },
  };
}

export const CLIENT_NAMES = Object.keys(clientSnippets(PUBLISHED));

export function formatSnippet(s: ClientSnippet): string {
  return `# ${s.name}\n# ${s.where}\n\n${s.text}\n`;
}

/** Short setup text shown by `init` and by `start` in a terminal. */
export function setupGuide(cmd: ServerCommand = serverCommand()): string {
  const s = clientSnippets(cmd);
  return [
    "Add tiny-browse to your agent:",
    "",
    formatSnippet(s["claude-code"]!),
    formatSnippet(s.generic!),
    `Other clients: tiny-browse config <${CLIENT_NAMES.join("|")}>`,
  ].join("\n");
}
