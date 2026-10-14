/**
 * Shared helpers for the local demo scripts. The private keys below are Anvil's PUBLIC development keys
 * (printed by every `anvil` start); they exist only on a local chain and are never sent to the browser.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTRACTS_DIR = join(ROOT, "packages/contracts");
export const API_DIR = join(ROOT, "apps/api");
export const STATE_DIR = join(ROOT, ".fairplay");

export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
];

/** Loads KEY=VALUE pairs from the repo-root .env into process.env (without overriding real env vars). */
export function loadDotEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) initEnv();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

export function localChain(rpcUrl: string) {
  return defineChain({
    id: 31337,
    name: "Anvil (local)",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function clients(rpcUrl: string) {
  const chain = localChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 250 });
  const wallet = (i: number) => createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[i]!), chain, transport: http(rpcUrl) });
  return { chain, publicClient, wallet };
}

export async function rpcAlive(rpcUrl: string): Promise<number | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    const j = (await res.json()) as { result?: string };
    return j.result ? Number(j.result) : null;
  } catch {
    return null;
  }
}

/** Starts a detached Anvil (1-second blocks, so timestamps track wall-clock time) and waits for it. */
export async function startAnvil(port: number): Promise<number> {
  mkdirSync(STATE_DIR, { recursive: true });
  const out = openSync(join(STATE_DIR, "anvil.log"), "a");
  const child = spawn("anvil", ["--port", String(port), "--host", "127.0.0.1", "--block-time", "1", "--chain-id", "31337"], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if ((await rpcAlive(`http://127.0.0.1:${port}`)) === 31337) return child.pid!;
    await sleep(200);
  }
  throw new Error("anvil did not start — see .fairplay/anvil.log");
}

export function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  return execFileSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function step(n: number, total: number, msg: string) {
  console.log(`\n\x1b[32m[${n}/${total}]\x1b[0m ${msg}`);
}

/**
 * Create .env from .env.example for the LOCAL demo: fills the private-key placeholders with Anvil's PUBLIC
 * development keys (accounts #1 and #2), only when the template targets chain 31337. Never overwrites .env.
 */
export function initEnv(opts: { quiet?: boolean } = {}): boolean {
  const target = join(ROOT, ".env");
  if (existsSync(target)) {
    if (!opts.quiet) console.log(".env already exists — left unchanged");
    return false;
  }
  let s = readFileSync(join(ROOT, ".env.example"), "utf8");
  const chain = /^CHAIN_ID=(\d+)/m.exec(s)?.[1];
  if (chain !== "31337") throw new Error(`.env.example targets chain ${chain}; fill .env by hand for non-local chains`);
  s = s.replace("<operator-private-key>", ANVIL_KEYS[1]!).replace("<oracle-reporter-private-key>", ANVIL_KEYS[2]!);
  writeFileSync(target, s, { mode: 0o600 });
  if (!opts.quiet) console.log("wrote .env (local chain 31337, Anvil public development keys)");
  return true;
}
