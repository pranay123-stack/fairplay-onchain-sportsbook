/**
 * The app built for SEPOLIA (NEXT_PUBLIC_CHAIN_ID=11155111), run against a LOCAL FORK of Sepolia.
 *
 * ⚠ This is a rehearsal, not Sepolia: the chain is `anvil --fork-url <sepolia rpc>` (real chain id 11155111,
 * real Sepolia state, all transactions stay local). The wallet is the SIMULATED EIP-1193 provider; the bettor is
 * a fresh address impersonated on the fork (no private key anywhere). Run with:
 *   E2E_NETWORK=sepolia-fork E2E_BASE_URL=http://localhost:3610 E2E_API_URL=http://127.0.0.1:4610 \
 *   E2E_RPC_URL=http://127.0.0.1:8566 pnpm test:e2e
 */
import { expect, type Page, test } from "@playwright/test";
import { createWalletClient, defineChain, type Hex, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bettingMarketAbi, mockUsdcAbi } from "@fairplay/shared";
import { API, chainMarket, config, publicClient, RPC } from "./helpers";
import { connectInjected, installSimulatedWallet, setWallet, walletSwitchChain } from "./simulated-wallet";

test.describe.configure({ mode: "serial" });
const SEPOLIA_HEX = "0xaa36a7";
const bettor = `0x${Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")}`;

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}

test.beforeAll(async () => {
  expect(await publicClient.getChainId(), "this suite must run against a chain reporting Sepolia's id").toBe(11155111);
  // Fresh bettor on the fork: impersonated (node signs) and given fork-only ETH for gas.
  await rpc("anvil_impersonateAccount", [bettor]);
  await rpc("anvil_setBalance", [bettor, "0x16345785D8A0000"]);
});

async function withWallet(page: Page, chainId = SEPOLIA_HEX) {
  await installSimulatedWallet(page, { rpc: RPC, account: bettor, chainId, appChainId: SEPOLIA_HEX });
}

test("Sepolia build: real browser wallets only — no simulated development wallet, network is labelled", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("network-badge")).toHaveText("Sepolia testnet");
  await expect(page.getByText(/Public testnet demonstration/)).toBeVisible();
  await page.getByTestId("connect-wallet").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/Browser Wallet|Injected/).first()).toBeVisible();
  await expect(dialog.getByText(/Anvil dev/)).toHaveCount(0);
  await expect(dialog.getByText(/Local demo/)).toHaveCount(0);
  const cfg = await (await fetch(`${API}/api/config`)).json();
  expect(cfg.chainId).toBe(11155111);
  expect(cfg.rpcUrl).toBeNull(); // the backend RPC (may contain a key) is never exposed
});

test("network switching: wallet on mainnet is switched to Sepolia; moving the wallet to another network shows Wrong network and switches back", async ({ page }) => {
  await withWallet(page, "0x1");
  await page.goto("/");
  await connectInjected(page);
  await expect(page.getByTestId("account-button")).toBeVisible(); // RainbowKit asked the wallet to switch to Sepolia
  expect(await page.evaluate(() => (window as unknown as { __wallet: { state: { chainId: string } } }).__wallet.state.chainId)).toBe(SEPOLIA_HEX);

  await walletSwitchChain(page, "0x1"); // user moves the wallet to another network
  await expect(page.getByRole("button", { name: "Wrong network" })).toBeVisible();
  await page.getByRole("button", { name: "Wrong network" }).click();
  await page.getByRole("dialog").getByText(/^Sepolia$/).click();
  await expect(page.getByTestId("account-button")).toBeVisible();
});

test("signature rejection on admin sign-in leaves no session", async ({ page }) => {
  await withWallet(page);
  await page.goto("/admin");
  await connectInjected(page);
  await setWallet(page, { rejectSign: true });
  await page.getByTestId("admin-sign-in").click();
  await expect(page.getByTestId("admin-signin-error")).toContainText(/rejected/i);
  await expect(page.getByRole("tab", { name: "Markets" })).toHaveCount(0);
});

test("transaction submission + confirmation: faucet, then approve and bet with a pending phase", async ({ page }) => {
  const { contracts } = await config();
  await withWallet(page);
  const events = await (await fetch(`${API}/api/events`)).json();
  const ev = events.find((e: { homeTeam: string }) => e.homeTeam === "Harbor Hawks");
  expect(ev, "seeded Sepolia demo event").toBeTruthy();
  const market = ev.markets[0];
  await page.goto(`/events/${ev.id}`);
  await connectInjected(page);

  // Faucet: real MockUSDC.faucet() transaction, confirmed by receipt and read back from the chain.
  const before = await publicClient.readContract({ address: contracts.mockUSDC, abi: mockUsdcAbi, functionName: "balanceOf", args: [bettor as `0x${string}`] });
  await page.getByTestId("faucet-button").first().click();
  await expect(page.getByText(/Received 1,000 mUSDC/)).toBeVisible({ timeout: 60_000 });
  const after = await publicClient.readContract({ address: contracts.mockUSDC, abi: mockUsdcAbi, functionName: "balanceOf", args: [bettor as `0x${string}`] });
  expect(after - before).toBe(1_000_000_000n);

  await page.getByTestId(`odds-${market.onchainId}-0`).click();
  const slip = page.getByTestId("bet-slip").first();
  await slip.getByTestId("stake-input").fill("20");
  await expect(slip.getByTestId("executable-odds")).toHaveText("1.8500");
  await slip.getByTestId("approve-button").click();
  await expect(slip.getByTestId("place-bet-button")).toBeVisible({ timeout: 60_000 });

  // Wallet rejection of a transaction: nothing placed.
  const stakeBefore = (await chainMarket(market.onchainId)).totalStake;
  await setWallet(page, { rejectSend: true });
  await slip.getByTestId("place-bet-button").click();
  await expect(slip.getByTestId("bet-error")).toContainText("You rejected the request in your wallet.");
  expect((await chainMarket(market.onchainId)).totalStake).toBe(stakeBefore);

  // Pending (held in the wallet) → no success; then confirmation from the receipt.
  await setWallet(page, { rejectSend: false, holdSend: true });
  await slip.getByTestId("place-bet-button").click();
  await expect(slip.getByTestId("place-bet-button")).toContainText("Confirm in wallet");
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("bet-confirmed")).toHaveCount(0);
  await setWallet(page, { holdSend: false });
  const done = page.getByTestId("bet-confirmed").first();
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done).toContainText("1.8500");
  expect((await chainMarket(market.onchainId)).totalStake).toBe(stakeBefore + 20_000_000n);

  // The transaction viewer reads the Sepolia(-fork) receipt through the API.
  await done.locator("a[href^='/tx/']").first().click();
  await expect(page.getByTestId("tx-status")).toHaveText(/Success/);
  await expect(page.getByText("BetPlaced").first()).toBeVisible();
  const ids = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getBetIds", args: [bettor as `0x${string}`] });
  expect(ids.length).toBe(1);
});

test("indexer picked up the Sepolia-config bet and the read model reconciles with the contracts", async () => {
  await expect
    .poll(async () => (await (await fetch(`${API}/api/bets/${bettor}`)).json()).length, { timeout: 60_000 })
    .toBe(1);
  await expect
    .poll(async () => {
      const s = await (await fetch(`${API}/api/platform/stats`)).json();
      return s.reconciliation.checkedAt && s.reconciliation.ok && s.indexer.confirmations === 3;
    }, { timeout: 90_000 })
    .toBe(true);
});

test("admin lifecycle on the Sepolia config: close → signed resolve via mock oracle → keeper settles → bettor claims in the UI", async ({ page }) => {
  const key = process.env.E2E_ADMIN_KEY as Hex | undefined;
  test.skip(!key, "E2E_ADMIN_KEY (the rehearsal's throwaway deployer key) not provided");
  const chain = defineChain({ id: 11155111, name: "sepolia-fork", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const admin = createWalletClient({ account: privateKeyToAccount(key!), chain, transport: http(RPC) });
  const call = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const r = await fetch(`${API}${path}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const nonce = await call(`/api/auth/nonce?address=${admin.account.address}`);
  expect(nonce.body.message).toContain("Chain ID: 11155111");
  const login = await call("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address: admin.account.address, message: nonce.body.message, signature: await admin.signMessage({ message: nonce.body.message }) }),
  });
  expect(login.status).toBe(200);
  const token = login.body.token as string;

  const events = await (await fetch(`${API}/api/events`)).json();
  const market = events.find((e: { homeTeam: string }) => e.homeTeam === "Harbor Hawks").markets[0];
  expect((await call(`/api/admin/markets/${market.id}/close`, { method: "POST", token })).status).toBe(200);
  const params = { winningOutcome: 0, source: "FairPlay mock oracle — admin-controlled (Sepolia-fork rehearsal)" };
  const ch = await call("/api/auth/action-nonce", { method: "POST", token, body: JSON.stringify({ action: "resolve", marketId: market.id, params }) });
  const res = await call(`/api/admin/markets/${market.id}/resolve`, {
    method: "POST",
    token,
    body: JSON.stringify({ ...params, nonce: ch.body.nonce, signature: await admin.signMessage({ message: ch.body.message }) }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // 20s dispute window + 15s keeper interval on this configuration.
  await expect.poll(async () => (await chainMarket(market.onchainId)).status, { timeout: 120_000, intervals: [3000] }).toBe(3);

  await withWallet(page);
  await page.goto("/my-bets");
  await connectInjected(page);
  const row = page.getByTestId("bet-row").first();
  await expect(row.getByText("Won · claimable")).toBeVisible({ timeout: 60_000 });
  await row.getByRole("button", { name: /Claim payout/ }).click();
  await expect(page.getByText("Claim confirmed on-chain")).toBeVisible({ timeout: 60_000 });
  const { contracts } = await config();
  const ids = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getBetIds", args: [bettor as `0x${string}`] });
  const bet = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getBet", args: [ids[0]!] });
  expect(bet.claimed).toBe(true);
});
