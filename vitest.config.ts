import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __TINY_BROWSE_VERSION__: JSON.stringify("0.0.0-test") },
  test: {
    include: ["test/**/*.test.ts"],
    // Many test files start their own Chrome. CI runners have few cores, so
    // run fewer files at once there to keep browser timings realistic.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
