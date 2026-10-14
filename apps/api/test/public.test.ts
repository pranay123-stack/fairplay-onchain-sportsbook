import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bettingMarketAbi, computePayout } from "@fairplay/shared";
import { ADMIN, BETTOR, createHarness, type Harness } from "./helpers.ts";

let h: Harness;
let token: string;
let ids: { eventId: string; marketId: string; onchainId: number };
let betTx: string;
beforeAll(async () => {
  h = await createHarness();
  await h.ensureHouse();
  await h.fund(BETTOR);
  token = (await h.login(ADMIN)).token!;
  ids = await h.createEventAndMarket(token);
  betTx = (await h.placeBet(BETTOR, ids.onchainId, 1, "12.5")).hash;
  await h.ctx.indexer.syncToHead();
});
afterAll(async () => h.close());

describe("public API", () => {
  it("lists events with markets, filters and search", async () => {
    const all = (await h.app.inject({ method: "GET", url: "/api/events" })).json();
    expect(all.some((e: { id: string }) => e.id === ids.eventId)).toBe(true);
    const football = (await h.app.inject({ method: "GET", url: "/api/events?sport=football&q=home" })).json();
    expect(football.every((e: { sport: string }) => e.sport === "football")).toBe(true);
    expect(football.length).toBeGreaterThan(0);
    const none = (await h.app.inject({ method: "GET", url: "/api/events?sport=esports" })).json();
    expect(none).toEqual([]);
    const bad = await h.app.inject({ method: "GET", url: "/api/events?sport=cricket" });
    expect(bad.statusCode).toBe(400);
  });

  it("serves an event and a market with odds history and recent bets", async () => {
    const ev = (await h.app.inject({ method: "GET", url: `/api/events/${ids.eventId}` })).json();
    expect(ev.isDemo).toBe(true);
    expect(ev.markets[0].outcomes).toHaveLength(3);
    const m = (await h.app.inject({ method: "GET", url: `/api/markets/${ids.marketId}` })).json();
    expect(m.status).toBe("OPEN");
    expect(m.totalStake).toBe("12500000");
    expect(m.oddsHistory[0].source).toBe("initial");
    expect(m.recentBets[0].outcomeLabel).toBe("Draw");
    expect((await h.app.inject({ method: "GET", url: "/api/markets/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/api/markets/not-a-uuid" })).statusCode).toBe(400);
  });

  it("serves executable odds", async () => {
    const odds = (await h.app.inject({ method: "GET", url: `/api/odds?marketId=${ids.marketId}` })).json();
    expect(odds[0].executable.map((o: { odds: string }) => o.odds)).toEqual(["25000", "34000", "28000"]);
    expect(odds[0].pending).toBeNull();
  });

  it("serves a wallet's bets with the locked odds and derived status", async () => {
    const bets = (await h.app.inject({ method: "GET", url: `/api/bets/${h.wallet(BETTOR).account.address}` })).json();
    const b = bets.find((x: { placedTxHash: string }) => x.placedTxHash === betTx);
    expect(b).toMatchObject({ status: "OPEN", stake: "12500000", odds: "34000", outcomeLabel: "Draw", eventLabel: "Home FC vs Away FC" });
    expect(b.potentialPayout).toBe(computePayout(12_500_000n, 34_000n, 200).net.toString());
    expect((await h.app.inject({ method: "GET", url: "/api/bets/0x123" })).statusCode).toBe(400);
  });

  it("decodes a transaction from the chain", async () => {
    const tx = (await h.app.inject({ method: "GET", url: `/api/transactions/${betTx}` })).json();
    expect(tx.status).toBe("success");
    expect(tx.functionName).toBe("placeBet");
    expect(tx.toLabel).toBe("BettingMarket");
    expect(tx.confirmations).toBeGreaterThanOrEqual(1);
    const events = tx.decodedLogs.map((l: { event: string }) => l.event);
    expect(events).toContain("BetPlaced");
    expect(events).toContain("Transfer");
    const missing = (await h.app.inject({ method: "GET", url: `/api/transactions/0x${"ab".repeat(32)}` })).json();
    expect(missing.status).toBe("not_found");
  });

  it("reports platform stats from live contract reads", async () => {
    const s = (await h.app.inject({ method: "GET", url: "/api/platform/stats" })).json();
    expect(s.onchain.escrowHeld).toBe(s.onchain.escrowRequired);
    expect(BigInt(s.onchain.houseBalance)).toBeGreaterThanOrEqual(BigInt(s.onchain.totalReserved));
    expect(s.oddsEngine.simulated).toBe(true);
    const total = await h.publicClient.readContract({ address: h.deployment.bettingMarket, abi: bettingMarketAbi, functionName: "betCount" });
    expect(s.onchain.betCount).toBe(Number(total));
  });

  it("restricts CORS to the configured web origins", async () => {
    const ok = await h.app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://localhost:3600" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3600");
    const evil = await h.app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } });
    expect(evil.statusCode).toBe(403);
  });

  it("rate-limits the authentication endpoints", async () => {
    const addr = h.wallet(BETTOR).account.address;
    const codes: number[] = [];
    for (let i = 0; i < 35; i++) codes.push((await h.app.inject({ method: "GET", url: `/api/auth/nonce?address=${addr}` })).statusCode);
    expect(codes).toContain(429);
  });
});

describe("payout maths: off-chain quote ≡ on-chain contract", () => {
  it("matches BettingMarket.computePayout on 300 random vectors", async () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const stake = BigInt(Math.floor(rand() * 5e10)) + 1n;
      const odds = BigInt(10_100 + Math.floor(rand() * 989_900));
      const fee = Math.floor(rand() * 1001);
      const [g, f, n] = await h.publicClient.readContract({ address: h.deployment.bettingMarket, abi: bettingMarketAbi, functionName: "computePayout", args: [stake, odds, fee] });
      const off = computePayout(stake, odds, fee);
      expect([off.gross, off.fee, off.net]).toEqual([g, f, n]);
    }
  });
});
