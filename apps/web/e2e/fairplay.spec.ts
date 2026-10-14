import { type Browser, expect, type Page, test } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4600";
test.describe.configure({ mode: "serial" });

const uniq = Date.now().toString(36).slice(-5).toUpperCase();
const HOME = `E2E Lions ${uniq}`;
const AWAY = `E2E Tigers ${uniq}`;

async function connect(page: Page, wallet: RegExp) {
  await page.getByTestId("connect-wallet").click();
  await page.getByRole("dialog").getByText(wallet).first().click();
  await expect(page.getByTestId("account-button")).toBeVisible();
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  return ctx.newPage();
}

async function apiJson<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  return r.json() as Promise<T>;
}

test("sportsbook lists demo events with live on-chain stats, filters and search", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Bet Transparently/ })).toBeVisible();
  await expect(page.getByText("Reconciled")).toBeVisible();
  await expect(page.getByTestId("event-card").first()).toBeVisible();
  await expect(page.getByText("Manchester City").first()).toBeVisible();

  await page.getByTestId("sport-esports").click();
  await expect(page.getByText("Team Alpha").first()).toBeVisible();
  await expect(page.getByText("Manchester City")).toHaveCount(0);

  await page.getByTestId("sport-all").click();
  await page.getByLabel("Search events").fill("lakers");
  await expect(page.getByTestId("event-card")).toHaveCount(1);
  await expect(page.getByText("Celtics").first()).toBeVisible();
});

test("admin signs in with a wallet signature and creates an event + market on-chain", async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto("/admin");
  await connect(page, /Admin \(dev\)/);
  await page.getByTestId("admin-sign-in").click();
  await expect(page.getByText("Admin console")).toBeVisible();
  await expect(page.getByText("Markets", { exact: true }).first()).toBeVisible();

  await page.getByRole("tab", { name: "Create" }).click();
  const createEvent = page.getByTestId("create-event-card");
  await createEvent.getByPlaceholder("Team A").fill(HOME);
  await createEvent.getByPlaceholder("Team B").fill(AWAY);
  await createEvent.getByRole("button", { name: /Create on-chain/ }).click();
  await expect(page.getByText("Event created on-chain")).toBeVisible();

  const createMarket = page.getByTestId("create-market-card");
  const select = createMarket.locator("select").first();
  await expect(select.locator("option", { hasText: HOME })).toHaveCount(1);
  const value = await select.locator("option", { hasText: HOME }).getAttribute("value");
  await select.selectOption(value!);
  await createMarket.getByLabel(/Include in simulated odds engine/).uncheck();
  await createMarket.getByRole("button", { name: /Create & open on-chain/ }).click();
  await expect(page.getByText(/Market #\d+ created and opened/)).toBeVisible();
  await page.context().close();
});

test("bettor connects, uses the faucet, approves and places a bet; odds lock on-chain", async ({ page }) => {
  const events = await apiJson<Array<{ id: string; homeTeam: string; markets: Array<{ onchainId: number; status: string }> }>>("/api/events");
  const ev = events.find((e) => e.homeTeam === HOME)!;
  expect(ev, "event created by the admin test").toBeTruthy();
  const marketId = ev.markets[0]!.onchainId;

  await page.goto(`/events/${ev.id}`);
  await connect(page, /Demo bettor/);

  // Faucet → real mint transaction; balance updates from the chain.
  const faucet = page.getByTestId("faucet-button").first();
  if (await faucet.isEnabled()) {
    await faucet.click();
    await expect(page.getByText(/Received 1,000 mUSDC/)).toBeVisible();
  }

  await page.getByTestId(`odds-${marketId}-0`).click();
  const slip = page.getByTestId("bet-slip").first();
  await slip.getByTestId("stake-input").fill("40");
  await expect(slip.getByTestId("executable-odds")).toHaveText("1.9000");
  // gross 76, fee 2% of 36 = 0.72 → net 75.28 — read from the contract's quote()
  await expect(slip.getByTestId("net-payout")).toHaveText("75.28 mUSDC");

  const approve = slip.getByTestId("approve-button");
  if (await approve.isVisible()) await approve.click();
  await slip.getByTestId("place-bet-button").click();

  const done = page.getByTestId("bet-confirmed").first();
  await expect(done).toBeVisible();
  await expect(done.getByText("1.9000")).toBeVisible();
  await expect(done.getByText("75.28 mUSDC")).toBeVisible();

  // The transaction page decodes the real receipt.
  await done.locator("a[href^='/tx/']").first().click();
  await expect(page.getByTestId("tx-status")).toHaveText(/Success/);
  await expect(page.getByText("placeBet")).toBeVisible();
  await expect(page.getByText("BetPlaced").first()).toBeVisible();
});

test("admin closes and resolves the market with a signed action; settlement follows on-chain", async ({ browser }) => {
  const events = await apiJson<Array<{ homeTeam: string; markets: Array<{ onchainId: number }> }>>("/api/events");
  const marketId = events.find((e) => e.homeTeam === HOME)!.markets[0]!.onchainId;
  const page = await newPage(browser);
  await page.goto("/admin");
  await connect(page, /Admin \(dev\)/);
  if (await page.getByTestId("admin-sign-in").isVisible()) await page.getByTestId("admin-sign-in").click();

  const row = page.getByTestId(`admin-market-${marketId}`);
  await row.getByTestId("close-market").click();
  await expect(row.getByText(/Closed/)).toBeVisible();

  await row.getByTestId("resolve-market").click();
  await page.getByTestId("winner-0").check();
  await page.getByTestId("confirm-resolve").click();
  await expect(page.getByText("Result published to the mock oracle")).toBeVisible();

  // Keeper settles once the 10s dispute window passes (or the admin can click Settle).
  await expect(row.getByText("Settled")).toBeVisible({ timeout: 60_000 });
  await page.context().close();
});

test("bettor claims the winning payout and the seeded refund; history updates", async ({ page }) => {
  await page.goto("/my-bets");
  await connect(page, /Demo bettor/);
  const rows = page.getByTestId("bet-row");
  await expect(rows.filter({ hasText: HOME })).toHaveCount(1);
  await expect(page.getByText("verified on-chain").first()).toBeVisible();

  const won = rows.filter({ hasText: HOME });
  await expect(won.getByText("Won · claimable")).toBeVisible();
  await won.getByRole("button", { name: /Claim payout/ }).click();
  await expect(page.getByText("Claim confirmed on-chain")).toBeVisible();
  await expect(won.getByText("Paid out")).toBeVisible({ timeout: 30_000 });

  const refund = rows.filter({ hasText: "Nebula Five" });
  if (await refund.getByRole("button", { name: /Claim refund/ }).isVisible()) {
    await refund.getByRole("button", { name: /Claim refund/ }).click();
    await expect(refund.getByText("Refunded")).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(refund.getByText("Refunded")).toBeVisible();
  }
});

test("transparency page shows a solvent, reconciled system with settlement records", async ({ page }) => {
  await page.goto("/transparency");
  await expect(page.getByTestId("solvency-ok")).toBeVisible();
  await expect(page.getByTestId("settlements-table")).toContainText(HOME);
  await expect(page.getByRole("heading", { name: /Trust assumptions/ })).toBeVisible();
  await expect(page.getByText(/mock oracle controlled by the operator/)).toBeVisible();
});

test("layout works at phone width without horizontal scroll", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const path of ["/", "/transparency", "/my-bets", "/admin"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
  const events = await apiJson<Array<{ id: string }>>("/api/events");
  await page.goto(`/events/${events[0]!.id}`);
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await ctx.close();
});
