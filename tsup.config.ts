import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

const shared = {
  format: ["esm"] as ("esm")[],
  platform: "node" as const,
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  define: { __TINY_BROWSE_VERSION__: JSON.stringify(pkg.version) },
};

export default defineConfig([
  // The command-line tool / MCP server.
  { ...shared, entry: { cli: "src/cli.ts" }, clean: false, banner: { js: "#!/usr/bin/env node" } },
  // The library: `import { webSearch } from "@shubhamcodess/tiny-browse"`, with type declarations.
  { ...shared, entry: { index: "src/index.ts" }, clean: false, dts: true },
]);
