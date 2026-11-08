import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  define: { __TINY_BROWSE_VERSION__: JSON.stringify(pkg.version) },
});
