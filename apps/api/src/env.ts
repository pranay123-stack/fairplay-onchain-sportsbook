import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import type { DeploymentInfo } from "@fairplay/shared";

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().default(4600),
  DATABASE_URL: z.string().url(),
  RPC_URL: z.string().url().default("http://127.0.0.1:8565"),
  CHAIN_ID: z.coerce.number().int().refine((c) => c === 31337 || c === 11155111, "CHAIN_ID must be 31337 (Anvil) or 11155111 (Sepolia)").default(31337),
  /** Path to the deployments JSON written by Deploy.s.sol. */
  DEPLOYMENT_FILE: z.string().default("../../packages/contracts/deployments/31337.json"),
  /** Comma-separated list of browser origins allowed by CORS (and Socket.IO). */
  WEB_ORIGINS: z.string().default("http://localhost:3600,http://127.0.0.1:3600"),
  /** Domain shown in sign-in messages; must match what the wallet user sees. */
  AUTH_DOMAIN: z.string().default("localhost:3600"),
  AUTH_NONCE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  /** Backend service keys. Locally these are Anvil's PUBLIC dev accounts #1 and #2. */
  OPERATOR_PRIVATE_KEY: hexKey,
  ORACLE_REPORTER_PRIVATE_KEY: hexKey,
  INDEXER_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  INDEXER_POLL_MS: z.coerce.number().int().min(200).default(1000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).max(64).default(1),
  INDEXER_BATCH_BLOCKS: z.coerce.number().int().min(1).max(10_000).default(2000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  KEEPER_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  KEEPER_INTERVAL_MS: z.coerce.number().int().min(500).default(3000),
  ODDS_ENGINE_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  ODDS_ENGINE_MIN_SECONDS: z.coerce.number().int().min(1).default(10),
  ODDS_ENGINE_MAX_SECONDS: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(600),
  /** Block explorer base URL; "none" disables explorer links (e.g. on a local fork). */
  EXPLORER_URL: z.union([z.string().url(), z.literal("none")]).optional(),
  /** viem polling interval for receipts/blocks. Keep ≥ 2000 against public RPCs. */
  RPC_POLLING_MS: z.coerce.number().int().min(100).default(500),
  /** How long a backend transaction may wait for its receipt. */
  TX_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(60_000),
});

export type Env = z.infer<typeof schema> & { deployment: DeploymentInfo; webOrigins: string[] };

/** Anvil's 10 default accounts (derived from its public mnemonic). Never acceptable off the local chain. */
export const ANVIL_DEV_ADDRESSES = new Set(
  [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  ].map((a) => a.toLowerCase()),
);
export const LOCAL_CHAIN_ID = 31337;
export const SEPOLIA_CHAIN_ID = 11155111;

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  const raw = { ...process.env, ...overrides };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.CHAIN_ID !== LOCAL_CHAIN_ID) {
    // Public network: refuse Anvil's development accounts outright, and require distinct service keys.
    const operator = privateKeyToAccount(env.OPERATOR_PRIVATE_KEY as `0x${string}`).address.toLowerCase();
    const reporter = privateKeyToAccount(env.ORACLE_REPORTER_PRIVATE_KEY as `0x${string}`).address.toLowerCase();
    for (const a of [operator, reporter]) {
      if (ANVIL_DEV_ADDRESSES.has(a)) throw new Error("Refusing to use a public Anvil development key on a non-local chain.");
    }
    if (operator === reporter) throw new Error("OPERATOR and ORACLE_REPORTER must be different keys on a public network.");
    // Safe defaults for a public testnet unless explicitly overridden: no gas-burning simulated odds engine,
    // gentler polling, deeper confirmations, a block explorer.
    if (raw.ODDS_ENGINE_ENABLED === undefined) env.ODDS_ENGINE_ENABLED = false;
    if (raw.RPC_POLLING_MS === undefined) env.RPC_POLLING_MS = 4_000;
    if (raw.INDEXER_POLL_MS === undefined) env.INDEXER_POLL_MS = 6_000;
    if (raw.INDEXER_CONFIRMATIONS === undefined) env.INDEXER_CONFIRMATIONS = 3;
    if (raw.INDEXER_BATCH_BLOCKS === undefined) env.INDEXER_BATCH_BLOCKS = 500;
    if (raw.KEEPER_INTERVAL_MS === undefined) env.KEEPER_INTERVAL_MS = 15_000;
    if (raw.TX_TIMEOUT_MS === undefined) env.TX_TIMEOUT_MS = 180_000;
    if (raw.EXPLORER_URL === undefined && env.CHAIN_ID === SEPOLIA_CHAIN_ID) env.EXPLORER_URL = "https://sepolia.etherscan.io";
  }
  const file = resolve(process.cwd(), env.DEPLOYMENT_FILE);
  let deployment: DeploymentInfo;
  try {
    deployment = JSON.parse(readFileSync(file, "utf8")) as DeploymentInfo;
  } catch (e) {
    throw new Error(`Cannot read deployment file ${file} — run \`pnpm demo:setup\` first. (${(e as Error).message})`);
  }
  if (deployment.chainId !== env.CHAIN_ID) {
    throw new Error(`Deployment file is for chain ${deployment.chainId} but CHAIN_ID is ${env.CHAIN_ID}`);
  }
  if (env.EXPLORER_URL === "none") env.EXPLORER_URL = undefined;
  return { ...env, deployment, webOrigins: env.WEB_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) };
}
