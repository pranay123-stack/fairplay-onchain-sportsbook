import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/setup/global-setup.ts"],
    // One real Anvil + one real Postgres database are shared, so files run one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ["test/**/*.test.ts"],
  },
});
