/**
 * Shared helpers for the e2e suites. They talk to the REAL running stack: the API over HTTP and the chain
 * over JSON-RPC (contract state is read directly, never inferred from the UI). The private keys below are
 * Anvil's PUBLIC development keys and are only used from Node, never injected into the page.
 */
import { expect, type Page } from "@playwright/test";
import { createPublicClient, createWalletClient, defineChain, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bettingMarketAbi, oracleAdapterAbi } from "@fairplay/shared";

export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4600";
export const RPC = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8565";

export const ACCOUNTS = {
  admin: { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const, key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex },
  bettorB: { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as const, key: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as Hex },
  bettorC: { address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc" as const, key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as Hex },
};

const chain = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
export const publicClient = createPublicClient({ chain, transport: http(RPC), cacheTime: 0 });

let cfgCache: { contracts: { bettingMarket: Hex; mockUSDC: Hex; oracleAdapter: Hex } } | null = null;
export async function config() {
  cfgCache ??= await (await fetch(`${API}/api/config`)).json();
  return cfgCache!;
}

export async function api<T = unknown>(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: { ...(rest.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/** Admin session obtained exactly like the UI does it (nonce → wallet signature → verify), from Node. */
export async function adminToken(): Promise<string> {
  const wallet = createWalletClient({ account: privateKeyToAccount(ACCOUNTS.admin.key), chain, transport: http(RPC) });
  const { body: n } = await api<{ message: string }>(`/api/auth/nonce?address=${ACCOUNTS.admin.address}`);
  const signature = await wallet.signMessage({ message: n.message });
  const { body } = await api<{ token: string }>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address: ACCOUNTS.admin.address, message: n.message, signature }),
  });
  return body.token;
}

/** A fresh event + open market that the simulated odds engine never touches (deterministic odds). */
export async function createTestMarket(token: string, label: string, odds = ["2.00", "3.20", "3.60"]) {
  const start = new Date(Date.now() + 30 * 3600_000).toISOString();
  const ev = await api<{ id: string }>("/api/admin/events", {
    method: "POST",
    token,
    body: JSON.stringify({ sport: "football", league: "E2E League (demo)", homeTeam: `${label} Home`, awayTeam: `${label} Away`, startTime: start }),
  });
  expect(ev.status, JSON.stringify(ev.body)).toBe(201);
  const labels = ["Home", "Draw", "Away"];
  const mk = await api<{ marketId: string; onchainId: number }>("/api/admin/markets", {
    method: "POST",
    token,
    body: JSON.stringify({
      eventId: ev.body.id,
      type: "MATCH_RESULT_1X2",
      title: `${label} result`,
      rules: "E2E test market — fictional fixture, settles on the mock oracle result.",
      outcomes: odds.map((o, i) => ({ label: labels[i], odds: o })),
      simulateOdds: false,
      openImmediately: true,
    }),
  });
  expect(mk.status, JSON.stringify(mk.body)).toBe(201);
  // Wait for the indexer, so the admin table lists it with its on-chain status.
  await expect.poll(async () => (await api<{ status: string }>(`/api/markets/${mk.body.marketId}`)).body.status, { timeout: 20_000 }).toBe("OPEN");
  return { eventId: ev.body.id, marketId: mk.body.marketId, onchainId: mk.body.onchainId };
}

export async function placeBetDirect(acct: keyof typeof ACCOUNTS, onchainId: number, outcome: number, stake: bigint) {
  const { contracts } = await config();
  const wallet = createWalletClient({ account: privateKeyToAccount(ACCOUNTS[acct].key), chain, transport: http(RPC) });
  const odds = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getOdds", args: [BigInt(onchainId)] });
  const hash = await wallet.writeContract({
    address: contracts.bettingMarket,
    abi: bettingMarketAbi,
    functionName: "placeBet",
    args: [BigInt(onchainId), BigInt(outcome), stake, odds[outcome]!],
  });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  expect(r.status).toBe("success");
  return hash;
}

export async function chainMarket(onchainId: number) {
  const { contracts } = await config();
  return publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getMarket", args: [BigInt(onchainId)] });
}

export async function chainOdds(onchainId: number) {
  const { contracts } = await config();
  const o = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getOdds", args: [BigInt(onchainId)] });
  return o.map(String);
}

export async function oracleResult(questionId: Hex) {
  const { contracts } = await config();
  return publicClient.readContract({ address: contracts.oracleAdapter, abi: oracleAdapterAbi, functionName: "getResult", args: [questionId] });
}

export async function connectDevWallet(page: Page, wallet: RegExp) {
  await page.getByTestId("connect-wallet").click();
  await page.getByRole("dialog").getByText(wallet).first().click();
  await expect(page.getByTestId("account-button")).toBeVisible();
}

export async function adminSignInUI(page: Page) {
  await page.goto("/admin");
  await connectDevWallet(page, /Admin \(dev\)/);
  await page.getByTestId("admin-sign-in").click();
  await expect(page.getByRole("tab", { name: "Markets" })).toBeVisible();
}

/** Holds every matching API response until `release()` — used to observe the UI's pending state. */
export async function holdResponses(page: Page, pattern: string | RegExp) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(pattern, async (route) => {
    const response = await route.fetch(); // the real request reaches the real API immediately
    await gate;
    await route.fulfill({ response });
  });
  return { release: () => release() };
}
