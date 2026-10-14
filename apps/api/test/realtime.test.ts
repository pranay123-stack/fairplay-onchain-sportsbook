import type { AddressInfo } from "node:net";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WS } from "@fairplay/shared";
import { ADMIN, BETTOR, createHarness, type Harness } from "./helpers.ts";

let h: Harness;
let socket: Socket;
let token: string;

beforeAll(async () => {
  h = await createHarness();
  await h.ensureHouse();
  await h.fund(BETTOR);
  token = (await h.login(ADMIN)).token!;
  h.ctx.realtime.attach(h.app.server, ["http://localhost:3600"]);
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = h.app.server.address() as AddressInfo;
  socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], extraHeaders: { origin: "http://localhost:3600" } });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  await h.ctx.indexer.syncToHead();
  h.ctx.indexer.start();
});

afterAll(async () => {
  socket?.close();
  await h.ctx.realtime.close();
  await h.close();
});

const next = <T>(event: string, pred: (p: T) => boolean = () => true, ms = 15_000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    const handler = (p: T) => {
      if (!pred(p)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });

describe("Socket.IO notifications", () => {
  it("broadcasts event creation, market creation and market opening", async () => {
    const created = next<{ id: string }>(WS.eventCreated);
    const marketCreated = next<{ onchainId: number }>(WS.marketCreated);
    const opened = next<{ status: string }>(WS.marketStatus, (p) => p.status === "OPEN");
    await h.createEventAndMarket(token);
    expect((await created).id).toBeTruthy();
    expect((await marketCreated).onchainId).toBeGreaterThan(0);
    expect((await opened).status).toBe("OPEN");
  });

  it("broadcasts pending and confirmed odds updates", async () => {
    const { marketId } = await h.createEventAndMarket(token);
    const pending = next<{ id: string; odds: string[] }>(WS.oddsPending, (p) => p.id === marketId);
    const confirmed = next<{ id: string; version: number }>(WS.oddsUpdated, (p) => p.id === marketId);
    await h.adminCall(token, "PATCH", `/api/admin/markets/${marketId}`, { odds: ["2.00", "3.00", "4.00"] });
    expect((await pending).odds).toEqual(["20000", "30000", "40000"]);
    expect((await confirmed).version).toBe(2);
  });

  it("confirms a bet to everyone and to the bettor's wallet room", async () => {
    const { onchainId } = await h.createEventAndMarket(token);
    const addr = h.wallet(BETTOR).account.address;
    socket.emit("subscribe:wallet", addr);
    await new Promise((r) => setTimeout(r, 100));
    const broadcast = next<{ betId: number; onchainId: number }>(WS.betConfirmed, (p) => p.onchainId === onchainId);
    const personal = next<{ bettor: string }>(`wallet:${WS.betConfirmed}`);
    const { hash } = await h.placeBet(BETTOR, onchainId, 0, "10");
    const b = await broadcast;
    expect(b.betId).toBeGreaterThan(0);
    expect((await personal).bettor).toBe(addr.toLowerCase());
    expect(h.ctx.realtime.emitted.some((e) => (e.payload as { txHash?: string }).txHash === hash)).toBe(true);
  });

  it("broadcasts market closure, oracle result, settlement and payout", async () => {
    const { marketId, onchainId } = await h.createEventAndMarket(token);
    await h.placeBet(BETTOR, onchainId, 2, "10");
    const closed = next<{ status: string }>(WS.marketStatus, (p) => p.status === "CLOSED");
    await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/close`);
    await closed;
    const reported = next<{ winningOutcome: number }>(WS.resultReported);
    const sig = await h.signAction(token, ADMIN, "resolve", marketId, { winningOutcome: 2, source: "ws test" });
    await h.adminCall(token, "POST", `/api/admin/markets/${marketId}/resolve`, { winningOutcome: 2, source: "ws test", ...sig });
    expect((await reported).winningOutcome).toBe(2);

    await h.warp(5);
    const settled = next<{ winningOutcome: number }>(WS.marketSettled);
    await h.ctx.markets.settle(marketId);
    expect((await settled).winningOutcome).toBe(2);

    const paid = next<{ amount: string; refund: boolean }>(WS.payoutClaimed);
    const ids = await h.publicClient.readContract({ address: h.deployment.bettingMarket, abi: (await import("@fairplay/shared")).bettingMarketAbi, functionName: "getBetIds", args: [h.wallet(BETTOR).account.address] });
    await h.write(BETTOR, { address: h.deployment.bettingMarket, abi: (await import("@fairplay/shared")).bettingMarketAbi, functionName: "claim", args: [ids[ids.length - 1]!] } as never);
    const p = await paid;
    expect(p.refund).toBe(false);
    expect(p.amount).toBe("27640000"); // 10 @ 2.80 → gross 28, fee 2% of 18 = 0.36 → 27.64
  });
});
