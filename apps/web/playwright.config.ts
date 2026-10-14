import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the REAL running stack (Anvil + API + web). Nothing is mocked.
 * Prerequisite: `pnpm demo:setup` then `scripts/stack.sh start` (or `pnpm dev:api` + `pnpm dev:web`).
 */
// E2E_NETWORK=sepolia-fork runs ONLY the Sepolia-configuration suite (against a local Sepolia fork);
// otherwise only the local-Anvil suites run.
const sepoliaFork = process.env.E2E_NETWORK === "sepolia-fork";

export default defineConfig({
  testDir: "./e2e",
  ...(sepoliaFork ? { testMatch: /sepolia-fork\.spec\.ts$/ } : { testIgnore: /sepolia-fork\.spec\.ts$/ }),
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3600",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } } }],
});
