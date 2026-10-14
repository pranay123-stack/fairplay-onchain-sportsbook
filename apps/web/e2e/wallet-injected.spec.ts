/**
 * Browser-wallet (EIP-1193 "injected") integration — the code path MetaMask and other extensions use.
 *
 * ⚠ SIMULATED WALLET. Headless CI cannot drive a real MetaMask extension, so these tests install a scripted
 * EIP-1193 provider as `window.ethereum`. It forwards real JSON-RPC to the local Anvil node (which signs with
 * its unlocked development account — no private key is ever placed in the page) and exposes test switches to
 * reproduce wallet behaviour: wrong network, rejecting a signature or transaction, holding a transaction in
 * "confirm in wallet", and emitting account changes. Genuine extension testing is a manual checklist in
 * docs/CLIENT_DEMO_CHECKLIST.md.
 */
import { expect, type Page, test } from "@playwright/test";
import { ACCOUNTS, adminToken, api, chainMarket, createTestMarket, RPC } from "./helpers";
import { connectInjected, installSimulatedWallet, setWallet, walletSwitchChain } from "./simulated-wallet";

test.describe.configure({ mode: "serial" });
const tag = `WAL${Date.now().toString(36).slice(-4).toUpperCase()}`;

async function withWallet(page: Page, account: string, chainId = "0x7a69") {
  await installSimulatedWallet(page, { rpc: RPC, account, chainId, appChainId: "0x7a69" });
}

let market: { eventId: string; marketId: string; onchainId: number };
let token: string;
test.beforeAll(async () => {
  token = await adminToken();
  market = await createTestMarket(token, tag, ["2.00", "3.00", "4.00"]);
});

test("connects, flags an unsupported network, and switches back to the local chain", async ({ page }) => {
  await withWallet(page, ACCOUNTS.bettorC.address, "0x1"); // wallet starts on Ethereum mainnet
  await page.goto("/");
  await connectInjected(page);
  // RainbowKit asks the wallet to switch to the app's chain while connecting; this wallet accepts.
  await expect(page.getByTestId("account-button")).toContainText("0x99");
  expect(await page.evaluate(() => (window as unknown as { __wallet: { state: { chainId: string } } }).__wallet.state.chainId)).toBe("0x7a69");

  // The user later changes network in the wallet → the app refuses to transact and offers a switch.
  await walletSwitchChain(page, "0x1");
  await expect(page.getByRole("button", { name: "Wrong network" })).toBeVisible();
  await expect(page.getByTestId("account-button")).toHaveCount(0);
  await page.getByRole("button", { name: "Wrong network" }).click();
  await page.getByRole("dialog").getByText("Anvil (local)").click();
  await expect(page.getByTestId("account-button")).toBeVisible();
});

test("follows a wallet account change and disconnects cleanly", async ({ page }) => {
  await withWallet(page, ACCOUNTS.bettorC.address);
  await page.goto("/my-bets");
  await connectInjected(page);
  await expect(page.getByText(ACCOUNTS.bettorC.address)).toBeVisible();

  await page.evaluate((a) => (window as unknown as { __wallet: { switchAccount(a: string): void } }).__wallet.switchAccount(a), ACCOUNTS.bettorB.address);
  await expect(page.getByText(ACCOUNTS.bettorB.address)).toBeVisible();
  await expect(page.getByTestId("account-button")).toContainText("0x15");

  await page.getByTestId("account-button").click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("connect-wallet").first()).toBeVisible();
  await expect(page.getByText("Connect a wallet to see your bets")).toBeVisible();
});

test("a rejected sign-in signature leaves no session", async ({ page }) => {
  await withWallet(page, ACCOUNTS.admin.address);
  await page.goto("/admin");
  await connectInjected(page);
  await setWallet(page, { rejectSign: true });
  await page.getByTestId("admin-sign-in").click();
  await expect(page.getByTestId("admin-signin-error")).toContainText(/rejected/i);
  await expect(page.getByRole("tab", { name: "Markets" })).toHaveCount(0);
  const stored = await page.evaluate(() => sessionStorage.getItem("fairplay.admin"));
  expect(stored === null || JSON.parse(stored).state?.token == null).toBe(true);
});

async function openSlip(page: Page, stake = "10") {
  await page.goto(`/events/${market.eventId}`);
  await connectInjected(page);
  await page.getByTestId(`odds-${market.onchainId}-0`).click();
  const slip = page.getByTestId("bet-slip").first();
  await slip.getByTestId("stake-input").fill(stake);
  await expect(slip.getByTestId("executable-odds")).not.toHaveText("…");
  return slip;
}

test("a transaction rejected in the wallet shows an error and nothing is placed", async ({ page }) => {
  await withWallet(page, ACCOUNTS.bettorC.address);
  const slip = await openSlip(page);
  const before = (await chainMarket(market.onchainId)).totalStake;
  await setWallet(page, { rejectSend: true });
  await slip.getByTestId("place-bet-button").click();
  await expect(slip.getByTestId("bet-error")).toContainText("You rejected the request in your wallet.");
  await expect(page.getByTestId("bet-confirmed")).toHaveCount(0);
  expect((await chainMarket(market.onchainId)).totalStake).toBe(before);
});

test("pending → confirmed: no success until the receipt, then values from the BetPlaced event", async ({ page }) => {
  await withWallet(page, ACCOUNTS.bettorC.address);
  const slip = await openSlip(page, "10");
  await setWallet(page, { holdSend: true });
  await slip.getByTestId("place-bet-button").click();
  await expect(slip.getByTestId("place-bet-button")).toContainText("Confirm in wallet");
  await expect(slip.getByTestId("place-bet-button")).toBeDisabled();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("bet-confirmed")).toHaveCount(0);

  const before = (await chainMarket(market.onchainId)).totalStake;
  await setWallet(page, { holdSend: false });
  const done = page.getByTestId("bet-confirmed").first();
  await expect(done).toBeVisible();
  await expect(done).toContainText(/Bet #\d+ confirmed on-chain/);
  expect((await chainMarket(market.onchainId)).totalStake).toBe(before + 10_000_000n);
});

test("a transaction that reverts on-chain (odds moved while in the wallet) is reported, not confirmed", async ({ page }) => {
  await withWallet(page, ACCOUNTS.bettorC.address);
  const slip = await openSlip(page, "10");
  const before = (await chainMarket(market.onchainId)).totalStake;
  await setWallet(page, { holdSend: true });
  await slip.getByTestId("place-bet-button").click();
  await expect(slip.getByTestId("place-bet-button")).toContainText("Confirm in wallet");

  // While the user is "looking at the wallet popup", the operator moves the price on-chain.
  const r = await api(`/api/admin/markets/${market.marketId}`, { method: "PATCH", token, body: JSON.stringify({ odds: ["1.80", "3.20", "4.40"] }) });
  expect(r.status).toBe(200);

  await setWallet(page, { holdSend: false }); // the bet is sent with the stale expectedOdds
  await expect(slip.getByTestId("bet-error")).toContainText(/odds changed/i);
  await expect(page.getByTestId("bet-confirmed")).toHaveCount(0);
  expect((await chainMarket(market.onchainId)).totalStake).toBe(before);
});

test("WalletConnect is not offered without a project id (none is configured locally)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByRole("dialog").getByText("WalletConnect")).toHaveCount(0);
  await expect(page.getByRole("dialog").getByText(/Anvil dev · Demo bettor/)).toBeVisible();
});
