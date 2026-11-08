import { describe, expect, it } from "vitest";
import { clientSnippets, serverCommand } from "../src/clients.js";

describe("client snippets", () => {
  it("uses npx when running from an installed package", () => {
    const cmd = serverCommand("/x/node_modules/tiny-browse/dist/cli.js", "/usr/bin/node");
    expect(cmd).toEqual({ command: "npx", args: ["-y", "tiny-browse"] });
  });

  it("points at the exact build when running from a checkout", () => {
    const cmd = serverCommand("/src/tiny-browse/dist/cli.js", "/usr/bin/node");
    expect(cmd).toEqual({ command: "/usr/bin/node", args: ["/src/tiny-browse/dist/cli.js"] });
  });

  it("quotes paths with spaces for the shell and TOML", () => {
    const s = clientSnippets({ command: "/usr/bin/node", args: ["/My Code/cli.js"] });
    expect(s["claude-code"]!.text).toBe("claude mcp add tiny-browse -- /usr/bin/node '/My Code/cli.js'");
    expect(s.codex!.text).toContain('args = ["/My Code/cli.js"]');
    expect(JSON.parse(s.generic!.text)).toEqual({
      mcpServers: { "tiny-browse": { command: "/usr/bin/node", args: ["/My Code/cli.js"] } },
    });
  });
});
