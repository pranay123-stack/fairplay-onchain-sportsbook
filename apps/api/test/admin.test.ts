import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bettingMarketAbi, oracleAdapterAbi } from "@fairplay/shared";
import { ROLES } from "../src/auth/auth-service.ts";
import { ADMIN, BETTOR, createHarness, type Harness } from "./helpers.ts";

let h: Harness;
let token: string;
beforeAll(async () => {
  h = await createHarness();
  await h.ensureHouse();
  token = (await h.login(ADMIN)).token!;
});
afterAll(async () => h.close());

describe("admin authorization", () => {
  it("requires a session", async () => {
    const r = await h.app.inject({ method: "POST", url: "/api/admin/events", payload: {} });
    expect(r.statusCode).toBe(401);
    const bad = await h.app.inject({ method: "GET", url: "/api/admin/me", headers: { authorization: "Bearer forged-token" } });
    expect(bad.statusCode).toBe(401);
  });

  it("re-checks the on-chain role on every request (revocation cuts off a live session)", async () => {
    const extra = 5;
    const addr = h.wallet(extra).account.address;
    await h.write(ADMIN, { address: h.deployment.bettingMarket, abi: bettingMarketAbi, functionName: "grantRole", args: [ROLES.MARKET_MANAGER_ROLE, addr] } as never);
    const { token: t2, res } = await h.login(extra);
    expect(res.statusCode).toBe(200);
    expect((await h.adminCall(t2!, "GET", "/api/admin/me")).statusCode).toBe(200);

    await h.write(ADMIN, { address: h.deployment.bettingMarket, abi: bettingMarketAbi, functionName: "revokeRole", args: [ROLES.MARKET_MANAGER_ROLE, addr] } as never);
    await new Promise((r) => setTimeout(r, 5_200)); // role cache TTL
    const after = await h.adminCall(t2!, "GET", "/api/admin/me");
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe("ROLE_REVOKED");
    expect(await h.ctx.db.adminAuditLog.count({ where: { outcome: "DENIED" } })).toBeGreaterThan(0);
  });
});

describe("admin validation", () => {
  it("rejects malformed events and markets", async () => {
    const r1 = await h.adminCall(token, "POST", "/api/admin/events", { sport: "cricket", league: "x", homeTeam: "a", awayTeam: "b", startTime: "tomorrow" });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe("VALIDATION_ERROR");

    const past = await h.adminCall(token, "POST", "/api/admin/events", {
      sport: "football", league: "League", homeTeam: "Aaa", awayTeam: "Bbb", startTime: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.code).toBe("START_TOO_SOON");

    const { eventId } = await h.createEventAndMarket(token);
    const badOdds = await h.adminCall(token, "POST", "/api/admin/markets", {
      eventId, type: "MONEYLINE", title: "Bad", rules: "Rules long enough here.", outcomes: [{ label: "A", odds: "1.00" }, { label: "B", odds: "2" }],
    });
    expect(badOdds.statusCode).toBe(400);
    const oneOutcome = await h.adminCall(token, "POST", "/api/admin/markets", {
      eventId, type: "MONEYLINE", title: "Bad", rules: "Rules long enough here.", outcomes: [{ label: "A", odds: "2.00" }],
    });
    expect(oneOutcome.statusCode).toBe(400);
  });
});

describe("admin market lifecycle (persisted to DB and chain)", () => {
  it("creates an event + market on-chain, indexes it, and records the audit log", async () => {
    const { eventId, marketId, onchainId } = await h.createEventAndMarket(token);
    const ev = await h.ctx.db.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(ev.onchainId).not.toBeNull();
    const onchain = await h.publicClient.readContract({ address: h.deployment.bettingMarket, abi: bettingMarketAbi, functionName: "getMarket", args: [BigInt(onchainId)] });
    expect(onchain.status).toBe(1); // Open
    expect(onchain.outcomeCount).toBe(3);

    await h.ctx.indexer.syncToHead();
    const m = await h.ctx.db.market.findUniqueOrThrow({ where: { id: marketId }, include: { outcomes: { orderBy: { index: "asc" } } } });
    expect(m.status).toBe("OPEN");
    expect(m.questionId).toBe(onchain.questionId.toLowerCase());
    expect(m.outcomes.map((o) => o.odds.toFixed(0))).toEqual(["25000", "34000", "28000"]);
    const audit = await h.ctx.db.adminAuditLog.findMany({ where: { action: { in: ["CREATE_EVENT", "CREATE_MARKET"] }, outcome: "OK" } });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("odds updates are PENDING until the indexer confirms them, and stale bets revert", async () => {
    const { marketId, onchainId } = await h.createEventAndMarket(token);
    await h.fund(BETTOR);
    const oldOdds = 25_000n;
    const r = await h.adminCall(token, "PATCH", `/api/admin/markets/${marketId}`, { odds: ["2.20", "3.50", "3.10"] });
    expect(r.statusCode).toBe(200);
    const pending = await h.ctx.db.oddsHistory.findFirstOrThrow({ where: { marketId, source: "admin" } });
    expect(pending.status).toBe("PENDING");
    expect(pending.txHash).toBe(r.json().txHash);

    await h.ctx.indexer.syncToHead();
    const confirmed = await h.ctx.db.oddsHistory.findUniqueOrThrow({ where: { id: pending.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.version).toBe(2);

    // A bet sent against the old price is rejected on-chain.
    await expect(
      h.write(BETTOR, { address: h.deployment.bettingMarket, abi: bettingMarketAbi, functionName: "placeBet", args: [BigInt(onchainId), 0n, 10_000_000n, oldOdds] } as never),
    ).rejects.toThrow(/OddsChanged/);
  });

  it("resolve requires a fresh signature bound to its exact parameters, and cannot be replayed", async () => {
    const { marketId, onchainId } = await h.createEventAndMarket(token);
    await h.fund(BETTOR);
    await h.placeBet(BETTOR, onchainId, 0, "100");

    // Must be closed first (results reported before close are rejected on-chain).
    const early = await h.signAction(token, ADMIN, "resolve", marketId, { winningOutcome: 0, source: "test oracle" });
    const tooEarly = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/resolve`, { winningOutcome: 0, source: "test oracle", ...early });
    expect(tooEarly.statusCode).toBe(409);

    expect((await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/close`)).statusCode).toBe(200);
    await h.ctx.indexer.syncToHead();

    const noSig = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/resolve`, { winningOutcome: 0 });
    expect(noSig.statusCode).toBe(400);

    // A signature for outcome 0 cannot be used to resolve outcome 2.
    const sig = await h.signAction(token, ADMIN, "resolve", marketId, { winningOutcome: 0, source: "test oracle" });
    const swapped = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/resolve`, { winningOutcome: 2, source: "test oracle", ...sig });
    expect(swapped.statusCode).toBe(401);
    expect(swapped.json().error.code).toBe("ACTION_SIGNATURE_INVALID");

    const sig2 = await h.signAction(token, ADMIN, "resolve", marketId, { winningOutcome: 0, source: "test oracle" });
    const ok = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/resolve`, { winningOutcome: 0, source: "test oracle", ...sig2 });
    expect(ok.statusCode).toBe(200);
    const replay = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/resolve`, { winningOutcome: 0, source: "test oracle", ...sig2 });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe("ACTION_REPLAY");

    // The on-chain oracle now has the result, reported by the reporter service (not by the API's admin).
    const q = (await h.ctx.db.market.findUniqueOrThrow({ where: { id: marketId } })).questionId!;
    const result = await h.publicClient.readContract({ address: h.deployment.oracleAdapter, abi: oracleAdapterAbi, functionName: "getResult", args: [q as `0x${string}`] });
    expect(result.status).toBe(1);
    expect(result.reporter.toLowerCase()).toBe(h.deployment.reporter.toLowerCase());

    // After the finality window the (permissionless) settlement goes through and the winner can claim.
    await h.warp(5);
    const settled = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/settle`);
    expect(settled.statusCode).toBe(200);
    await h.ctx.indexer.syncToHead();
    const bets = await h.app.inject({ method: "GET", url: `/api/bets/${h.wallet(BETTOR).account.address}` });
    const bet = bets.json().find((b: { marketId: string }) => b.marketId === marketId);
    expect(bet.status).toBe("WON");
    expect(bet.potentialPayout).toBe("247000000");
  });

  it("cancel via manager refunds stakes and is recorded in Settlement", async () => {
    const { marketId, onchainId } = await h.createEventAndMarket(token);
    await h.fund(BETTOR);
    await h.placeBet(BETTOR, onchainId, 1, "40");
    const sig = await h.signAction(token, ADMIN, "cancel", marketId, { reason: "fixture postponed", via: "manager" });
    const r = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/cancel`, { reason: "fixture postponed", via: "manager", ...sig });
    expect(r.statusCode).toBe(200);
    await h.ctx.indexer.syncToHead();
    const s = await h.ctx.db.settlement.findUniqueOrThrow({ where: { marketOnchainId: onchainId } });
    expect(s.kind).toBe("CANCELLED");
    expect(s.totalStake.toFixed(0)).toBe("40000000");
    const bets = (await h.app.inject({ method: "GET", url: `/api/bets/${h.wallet(BETTOR).account.address}` })).json();
    expect(bets.find((b: { marketId: string }) => b.marketId === marketId).status).toBe("REFUNDABLE");
  });

  it("surfaces contract reverts as structured CHAIN_REJECTED errors", async () => {
    const { marketId } = await h.createEventAndMarket(token);
    const r = await h.adminCall(token, "PATCH", `/api/admin/markets/${marketId}`, { odds: ["2.00", "2.00"] }); // wrong count
    expect(r.statusCode).toBe(400);
    expect((await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/close`)).statusCode).toBe(200);
    const again = await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/close`);
    expect(again.statusCode).toBe(422);
    expect(again.json().error.code).toBe("CHAIN_REJECTED");
    expect(again.json().error.details.reason).toBe("InvalidStatus");
  });
});
