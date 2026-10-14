/**
 * Boots the real dependencies for the API integration tests:
 *   • a dedicated Anvil on TEST_RPC_PORT (automine — no block time — for speed),
 *   • the real contracts, deployed with the real Deploy.s.sol (3s oracle finality),
 *   • the `fairplay_test` database, migrated with the real migrations.
 * Nothing is mocked.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

export const TEST_RPC_PORT = 8610;
const ROOT = join(import.meta.dirname, "../../../..");
const CONTRACTS = join(ROOT, "packages/contracts");
const API = join(ROOT, "apps/api");
export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://fairplay:fairplay@127.0.0.1:5482/fairplay_test";
export const TEST_DEPLOYMENT = join(CONTRACTS, "deployments/test-31337.json");

let anvil: ChildProcess | null = null;

async function rpcUp(url: string) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function setup(project: TestProject) {
  const rpc = `http://127.0.0.1:${TEST_RPC_PORT}`;
  if (await rpcUp(rpc)) throw new Error(`port ${TEST_RPC_PORT} is already in use — stop the stale test anvil first`);
  anvil = spawn("anvil", ["--port", String(TEST_RPC_PORT), "--host", "127.0.0.1", "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 50 && !(await rpcUp(rpc)); i++) await new Promise((r) => setTimeout(r, 100));

  execFileSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpc, "--broadcast"], {
    cwd: CONTRACTS,
    stdio: "ignore",
    env: {
      ...process.env,
      DEPLOYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      OPERATOR_ADDRESS: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      REPORTER_ADDRESS: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
      ORACLE_FINALITY_SECONDS: "3",
      DEPLOYMENT_OUT: TEST_DEPLOYMENT,
    },
  });
  execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: API, stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_DB } });

  project.provide("rpcUrl", rpc);
  project.provide("databaseUrl", TEST_DB);
  project.provide("deploymentFile", TEST_DEPLOYMENT);

  return () => {
    anvil?.kill();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
    databaseUrl: string;
    deploymentFile: string;
  }
}
