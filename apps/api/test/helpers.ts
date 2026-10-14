import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { createPublicClient, createWalletClient, defineChain, type Hex, http, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { inject } from "vitest";
import { bettingMarketAbi, type DeploymentInfo, mockUsdcAbi, parseUsdc } from "@fairplay/shared";
import { buildApp } from "../src/app.ts";
import { createContext } from "../src/bootstrap.ts";
import { loadEnv } from "../src/env.ts";
import { createLogger } from "../src/logger.ts";

export const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
];
export const ADMIN = 0;
export const BETTOR = 3;

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Real app context against the test chain + test database, with a clean read model. */
export async function createHarness(overrides: Record<string, string> = {}) {
  const rpcUrl = inject("rpcUrl");
  const databaseUrl = inject("databaseUrl");
  const deploymentFile = inject("deploymentFile");
  await truncate(databaseUrl);
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    RPC_URL: rpcUrl,
    DEPLOYMENT_FILE: deploymentFile,
    INDEXER_CONFIRMATIONS: "0",
    INDEXER_POLL_MS: "200",
    ODDS_ENGINE_ENABLED: "false",
    OPERATOR_PRIVATE_KEY: KEYS[1]!,
    ORACLE_REPORTER_PRIVATE_KEY: KEYS[2]!,
    WEB_ORIGINS: "http://localhost:3600",
    AUTH_DOMAIN: "localhost:3600",
    RATE_LIMIT_PER_MINUTE: "10000",
    ...overrides,
  });
  const log = createLogger("silent", false);
  const ctx = createContext(env, log);
  const app: FastifyInstance = await buildApp(ctx);
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as DeploymentInfo;
  const chain = defineChain({ id: 31337, name: "test", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 100 });
  const wallet = (i: number) => createWalletClient({ account: privateKeyToAccount(KEYS[i]!), chain, transport: http(rpcUrl) });

  const write = async (i: number, req: Parameters<ReturnType<typeof wallet>["writeContract"]>[0]) => {
    const hash = await wallet(i).writeContract(req as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
    return { hash, receipt };
  };

  /** Ensure the house has liquidity and `i` holds approved mUSDC. Idempotent. */
  const fund = async (i: number, amount = "5000") => {
    const addr = wallet(i).account.address;
    await write(ADMIN, { address: deployment.mockUSDC, abi: mockUsdcAbi, functionName: "mint", args: [addr, parseUsdc(amount)] } as never);
    await write(i, { address: deployment.mockUSDC, abi: mockUsdcAbi, functionName: "approve", args: [deployment.bettingMarket, maxUint256] } as never);
  };
  const ensureHouse = async () => {
    const hb = await publicClient.readContract({ address: deployment.bettingMarket, abi: bettingMarketAbi, functionName: "houseBalance" });
    if (hb >= parseUsdc("100000")) return;
    await fund(ADMIN, "200000");
    await write(ADMIN, { address: deployment.bettingMarket, abi: bettingMarketAbi, functionName: "depositLiquidity", args: [parseUsdc("200000")] } as never);
  };

  const login = async (i = ADMIN) => {
    const address = wallet(i).account.address;
    const nonce = await app.inject({ method: "GET", url: `/api/auth/nonce?address=${address}` });
    const { message } = nonce.json();
    const signature = await wallet(i).signMessage({ message });
    const res = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { address, message, signature } });
    return { res, token: res.json().token as string | undefined, address, message, signature };
  };

  /** Fetch + sign an action challenge exactly as the admin UI does. */
  const signAction = async (token: string, i: number, action: "resolve" | "cancel", marketId: string, params: Record<string, string | number>) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/action-nonce",
      headers: { authorization: `Bearer ${token}` },
      payload: { action, marketId, params },
    });
    const { nonce, message } = r.json();
    const signature = await wallet(i).signMessage({ message });
    return { nonce, signature };
  };

  const adminCall = (token: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  /** Creates an event + market through the admin API. */
  const createEventAndMarket = async (token: string, opts: { startsInSec?: number; odds?: string[]; maxLiability?: string } = {}) => {
    const chainNow = Number((await publicClient.getBlock()).timestamp) * 1000;
    const start = new Date(Math.max(Date.now(), chainNow) + (opts.startsInSec ?? 3600) * 1000).toISOString();
    const ev = await adminCall(token, "POST", "/api/admin/events", {
      sport: "football",
      league: "Test League",
      homeTeam: "Home FC",
      awayTeam: "Away FC",
      startTime: start,
    });
    if (ev.statusCode !== 201) throw new Error(`create event failed: ${ev.body}`);
    const odds = opts.odds ?? ["2.50", "3.40", "2.80"];
    const labels = ["Home FC", "Draw", "Away FC", "D", "E", "F", "G", "H"];
    const mk = await adminCall(token, "POST", "/api/admin/markets", {
      eventId: ev.json().id,
      type: "MATCH_RESULT_1X2",
      title: "Match result",
      rules: "Settles on the 90 minute result. Test market.",
      outcomes: odds.map((o, i) => ({ label: labels[i], odds: o })),
      maxLiability: opts.maxLiability ?? "50000",
    });
    if (mk.statusCode !== 201) throw new Error(`create market failed: ${mk.body}`);
    return { eventId: ev.json().id as string, marketId: mk.json().marketId as string, onchainId: mk.json().onchainId as number };
  };

  const placeBet = async (i: number, onchainId: number, outcome: number, stake: string) => {
    const odds = await publicClient.readContract({ address: deployment.bettingMarket, abi: bettingMarketAbi, functionName: "getOdds", args: [BigInt(onchainId)] });
    return write(i, {
      address: deployment.bettingMarket,
      abi: bettingMarketAbi,
      functionName: "placeBet",
      args: [BigInt(onchainId), BigInt(outcome), parseUsdc(stake), odds[outcome]!],
    } as never);
  };

  const rpc = (method: string, params: unknown[] = []) =>
    fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(
      (r) => r.json() as Promise<{ result: unknown }>,
    );
  /** Advance chain time (automine chain: mines one block). */
  const warp = async (seconds: number) => {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine");
  };

  const close = async () => {
    ctx.indexer.stop();
    await app.close();
    await ctx.db.$disconnect();
  };

  return { ctx, app, env, deployment, publicClient, wallet, write, fund, ensureHouse, login, signAction, adminCall, createEventAndMarket, placeBet, rpc, warp, close };
}

async function truncate(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const { rows } = await c.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'");
  await c.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
  await c.end();
}
