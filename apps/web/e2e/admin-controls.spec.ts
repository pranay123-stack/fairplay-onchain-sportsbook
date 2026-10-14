/**
 * Admin console controls that the core flow does not exercise: cancel, edit odds, simulate odds, and the
 * simulated-odds-engine toggle. Each test clicks the real UI, checks the API request/response, and reads the
 * resulting contract state directly from the chain. Pending and failure states are checked too: the UI
 * must never report success before the API (which waits for the transaction receipt) has succeeded.
 */
import { expect, test } from "@playwright/test";
import { parseUsdc } from "@fairplay/shared";
import { ACCOUNTS, adminSignInUI, adminToken, api, chainMarket, chainOdds, connectDevWallet, createTestMarket, holdResponses, placeBetDirect, publicClient, config } from "./helpers";
import { bettingMarketAbi } from "@fairplay/shared";

test.describe.configure({ mode: "serial" });
const tag = `ADM${Date.now().toString(36).slice(-4).toUpperCase()}`;
let token: string;

test.beforeAll(async () => {
  token = await adminToken();
});

test("unauthorised users cannot use the admin console or its API", async ({ page }) => {
  // UI: a wallet without an on-chain admin role gets a clear refusal and no dashboard.
  await page.goto("/admin");
  await connectDevWallet(page, /Demo bettor/);
  const verify = page.waitForResponse((r) => r.url().includes("/api/auth/verify"));
  await page.getByTestId("admin-sign-in").click();
  expect((await verify).status()).toBe(403);
  await expect(page.getByTestId("admin-signin-error")).toContainText("no admin role");
  await expect(page.getByRole("tab", { name: "Markets" })).toHaveCount(0);

  // API: every mutating admin route refuses missing/forged sessions, and the chain is untouched.
  const { marketId, onchainId } = await createTestMarket(token, `${tag}U`);
  const before = await chainMarket(onchainId);
  for (const [method, path, body] of [
    ["POST", `/api/admin/markets/${marketId}/cancel`, { reason: "nope", via: "manager", nonce: "x".repeat(32), signature: "0x00" }],
    ["PATCH", `/api/admin/markets/${marketId}`, { odds: ["9.00", "9.00", "9.00"] }],
    ["POST", `/api/admin/markets/${marketId}/simulate-odds`, {}],
    ["POST", `/api/admin/odds-engine`, { enabled: false }],
  ] as const) {
    expect((await api(path, { method, body: JSON.stringify(body) })).status, `${method} ${path} without session`).toBe(401);
    expect((await api(path, { method, body: JSON.stringify(body), token: "forged-token" })).status, `${method} ${path} forged`).toBe(401);
  }
  const after = await chainMarket(onchainId);
  expect(after.status).toBe(before.status);
  expect(after.oddsVersion).toBe(before.oddsVersion);
});

test("edit odds: pending until mined, then confirmed on-chain; invalid odds fail without success", async ({ page }) => {
  const { marketId, onchainId } = await createTestMarket(token, `${tag}E`);
  await adminSignInUI(page);
  const row = page.getByTestId(`admin-market-${onchainId}`);
  const versionBefore = (await chainMarket(onchainId)).oddsVersion;

  // ── failure path: odds below 1.01 are rejected and nothing reports success ──
  await row.getByTitle("Edit odds").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").nth(0).fill("1.00");
  const bad = page.waitForResponse((r) => r.url().endsWith(`/api/admin/markets/${marketId}`) && r.request().method() === "PATCH");
  await dialog.getByRole("button", { name: /Send setOdds transaction/ }).click();
  expect((await bad).status()).toBe(400);
  await expect(page.getByText("Odds update failed")).toBeVisible();
  await expect(page.getByText("Odds sent on-chain")).toHaveCount(0);
  expect((await chainMarket(onchainId)).oddsVersion).toBe(versionBefore);

  // ── success path, with the API response held back to observe the pending state ──
  await dialog.locator("input").nth(0).fill("2.25");
  await dialog.locator("input").nth(1).fill("3.10");
  await dialog.locator("input").nth(2).fill("3.30");
  const hold = await holdResponses(page, `**/api/admin/markets/${marketId}`);
  const req = page.waitForRequest((r) => r.url().endsWith(`/api/admin/markets/${marketId}`) && r.method() === "PATCH");
  const res = page.waitForResponse((r) => r.url().endsWith(`/api/admin/markets/${marketId}`) && r.request().method() === "PATCH");
  await dialog.getByRole("button", { name: /Send setOdds transaction/ }).click();
  expect((await req).postDataJSON()).toEqual({ odds: ["2.25", "3.10", "3.30"] });
  await expect(dialog.getByRole("button", { name: /Send setOdds transaction/ })).toBeDisabled();
  await page.waitForTimeout(1500);
  await expect(page.getByText("Odds sent on-chain")).toHaveCount(0); // no premature success
  hold.release();
  const r = await res;
  expect(r.status()).toBe(200);
  expect((await r.json()).txHash).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(page.getByText("Odds sent on-chain")).toBeVisible();

  // Contract state is the new price, and the read model confirms it after indexing.
  expect(await chainOdds(onchainId)).toEqual(["22500", "31000", "33000"]);
  expect((await chainMarket(onchainId)).oddsVersion).toBe(versionBefore + 1);
  await expect(row).toContainText("2.25 / 3.10 / 3.30", { timeout: 20_000 });
  const detail = await api<{ oddsHistory: Array<{ source: string; status: string }> }>(`/api/markets/${marketId}`);
  expect(detail.body.oddsHistory.at(-1)).toMatchObject({ source: "admin", status: "CONFIRMED" });
});

test("simulate odds: one real setOdds move, confirmed on-chain", async ({ page }) => {
  const { marketId, onchainId } = await createTestMarket(token, `${tag}S`);
  await adminSignInUI(page);
  const row = page.getByTestId(`admin-market-${onchainId}`);
  const before = await chainOdds(onchainId);
  const versionBefore = (await chainMarket(onchainId)).oddsVersion;

  const hold = await holdResponses(page, `**/api/admin/markets/${marketId}/simulate-odds`);
  const res = page.waitForResponse((r) => r.url().endsWith(`/api/admin/markets/${marketId}/simulate-odds`));
  await row.getByTitle("Simulate an odds move").click();
  await expect(row.getByTitle("Simulate an odds move")).toBeDisabled();
  await page.waitForTimeout(1000);
  await expect(page.getByText("Confirmed on-chain")).toHaveCount(0);
  hold.release();
  const r = await res;
  expect(r.status()).toBe(200);
  expect((await r.json()).moved).toBe(marketId);
  await expect(page.getByText("Confirmed on-chain").first()).toBeVisible();

  expect((await chainMarket(onchainId)).oddsVersion).toBe(versionBefore + 1);
  const after = await chainOdds(onchainId);
  expect(after).not.toEqual(before);
  for (const o of after) expect(Number(o)).toBeGreaterThanOrEqual(10_500); // engine clamps to ≥ 1.05
  const detail = await api<{ oddsHistory: Array<{ source: string; status: string }> }>(`/api/markets/${marketId}`);
  await expect.poll(async () => (await api<{ oddsHistory: Array<{ source: string; status: string }> }>(`/api/markets/${marketId}`)).body.oddsHistory.at(-1)).toMatchObject({
    source: "simulated-engine",
    status: "CONFIRMED",
  });
  expect(detail.status).toBe(200);
});

test("odds engine toggle: off and back on, reflected by the API and the audit log", async ({ page }) => {
  await adminSignInUI(page);
  const toggle = page.getByTestId("odds-engine-toggle");
  const initial = (await api<{ enabled: boolean }>("/api/admin/odds-engine", { token })).body.enabled;
  await expect(toggle).toHaveText(initial ? "On" : "Off");

  for (const want of [!initial, initial]) {
    const req = page.waitForRequest((r) => r.url().endsWith("/api/admin/odds-engine") && r.method() === "POST");
    const res = page.waitForResponse((r) => r.url().endsWith("/api/admin/odds-engine") && r.request().method() === "POST");
    await toggle.click();
    expect((await req).postDataJSON()).toEqual({ enabled: want });
    const r = await res;
    expect(r.status()).toBe(200);
    expect(await r.json()).toEqual({ enabled: want });
    await expect(page.getByText(`Simulated odds engine ${want ? "on" : "off"}`)).toBeVisible();
    await expect(toggle).toHaveText(want ? "On" : "Off", { timeout: 15_000 });
    expect((await api<{ enabled: boolean }>("/api/admin/odds-engine", { token })).body.enabled).toBe(want);
  }
  const audit = await api<Array<{ action: string; outcome: string }>>("/api/admin/audit-log", { token });
  expect(audit.body.filter((a) => a.action === "ODDS_ENGINE" && a.outcome === "OK").length).toBeGreaterThanOrEqual(2);
});

test("cancel: signed action, pending until mined, stakes become refundable on-chain; invalid input fails cleanly", async ({ page }) => {
  const { marketId, onchainId } = await createTestMarket(token, `${tag}C`);
  await placeBetDirect("bettorC", onchainId, 2, parseUsdc("12"));
  await adminSignInUI(page);
  const row = page.getByTestId(`admin-market-${onchainId}`);

  // ── failure path: a too-short reason is rejected; market stays open on-chain ──
  await row.getByTitle("Cancel market & refund").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("textarea").fill("no");
  const bad = page.waitForResponse((r) => r.url().endsWith(`/api/admin/markets/${marketId}/cancel`));
  await dialog.getByRole("button", { name: /Sign & cancel/ }).click();
  expect((await bad).status()).toBe(400);
  await expect(page.getByText("Cancel failed")).toBeVisible();
  expect((await chainMarket(onchainId)).status).toBe(1); // Open

  // ── success path ──
  await dialog.locator("textarea").fill(`Fixture postponed (simulated, ${tag})`);
  await dialog.locator("select").selectOption("manager");
  const hold = await holdResponses(page, `**/api/admin/markets/${marketId}/cancel`);
  const req = page.waitForRequest((r) => r.url().endsWith(`/api/admin/markets/${marketId}/cancel`));
  const res = page.waitForResponse((r) => r.url().endsWith(`/api/admin/markets/${marketId}/cancel`));
  await dialog.getByRole("button", { name: /Sign & cancel/ }).click();
  const body = (await req).postDataJSON();
  expect(body).toMatchObject({ reason: `Fixture postponed (simulated, ${tag})`, via: "manager" });
  expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/); // a fresh single-use action signature
  expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
  await expect(dialog.getByRole("button", { name: /Sign & cancel/ })).toBeDisabled();
  await page.waitForTimeout(1000);
  await expect(page.getByText("Market cancelled — stakes refundable")).toHaveCount(0);
  hold.release();
  const r = await res;
  expect(r.status()).toBe(200);
  await expect(page.getByText("Market cancelled — stakes refundable")).toBeVisible();

  expect((await chainMarket(onchainId)).status).toBe(4); // Cancelled
  const { contracts } = await config();
  const ids = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "getBetIds", args: [ACCOUNTS.bettorC.address] });
  const status = await publicClient.readContract({ address: contracts.bettingMarket, abi: bettingMarketAbi, functionName: "betStatus", args: [ids[ids.length - 1]!] });
  expect(status).toBe(4); // Refundable
  await expect(row).toContainText("Cancelled", { timeout: 20_000 });
  // The signature cannot be replayed through the API.
  const replay = await api(`/api/admin/markets/${marketId}/cancel`, { method: "POST", token, body: JSON.stringify(body) });
  expect(replay.status).toBe(401);
});
