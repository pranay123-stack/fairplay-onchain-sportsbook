import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Indexer } from "../src/indexer/indexer.ts";
import { ADMIN, BETTOR, createHarness, type Harness } from "./helpers.ts";

let h: Harness;
let token: string;
beforeAll(async () => {
  h = await createHarness();
  await h.ensureHouse();
  await h.fund(BETTOR);
  await h.fund(4);
  token = (await h.login(ADMIN)).token!;
});
afterAll(async () => h.close());

async function snapshot() {
  const [logs, bets, markets, outcomes] = await Promise.all([
    h.ctx.db.chainLog.count(),
    h.ctx.db.betIndex.findMany({ orderBy: { betId: "asc" } }),
    h.ctx.db.market.findMany({ where: { onchainId: { not: null } }, orderBy: { onchainId: "asc" } }),
    h.ctx.db.outcome.findMany({ orderBy: [{ marketId: "asc" }, { index: "asc" }] }),
  ]);
  return {
    logs,
    bets: bets.map((b) => [b.betId, b.stake.toFixed(0), b.claimed]),
    markets: markets.map((m) => [m.onchainId, m.status, m.totalStake.toFixed(0), m.reserved.toFixed(0), m.oddsVersion]),
    outcomes: outcomes.map((o) => [o.marketId, o.index, o.stake.toFixed(0), o.betCount]),
  };
}

describe("indexer", () => {
  it("indexes the full history from the deploy block and reconciles exactly with the contract", async () => {
    const { onchainId } = await h.createEventAndMarket(token);
    await h.placeBet(BETTOR, onchainId, 0, "100");
    await h.placeBet(4, onchainId, 2, "60");
    await h.ctx.indexer.syncToHead();
    const report = await h.ctx.reconciler.run();
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedBets).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent: re-processing the same block range changes nothing", async () => {
    await h.ctx.indexer.syncToHead();
    const before = await snapshot();
    const state = await h.ctx.db.indexerState.findUniqueOrThrow({ where: { id: "main" } });
    // Rewind progress WITHOUT deleting anything and index the whole range again.
    await h.ctx.db.indexerState.update({ where: { id: "main" }, data: { lastBlock: h.deployment.deployBlock - 1 } });
    await h.ctx.indexer.syncToHead();
    const after = await snapshot();
    expect(after).toEqual(before);
    expect((await h.ctx.db.indexerState.findUniqueOrThrow({ where: { id: "main" } })).lastBlock).toBeGreaterThanOrEqual(state.lastBlock);
    expect((await h.ctx.reconciler.run()).ok).toBe(true);
  });

  it("resumes after a restart from its committed block", async () => {
    const { onchainId } = await h.createEventAndMarket(token);
    await h.ctx.indexer.syncToHead();
    const committed = (await h.ctx.db.indexerState.findUniqueOrThrow({ where: { id: "main" } })).lastBlock;
    await h.placeBet(BETTOR, onchainId, 1, "25");

    // A brand-new indexer instance (as after a process restart) picks up from `committed`.
    const fresh = new Indexer(h.ctx.db, h.ctx.chain, h.ctx.realtime, h.ctx.log, {
      confirmations: 0, batchBlocks: 2000, pollMs: 200, deployBlock: h.deployment.deployBlock, chainId: 31337,
    });
    const r = await fresh.tick();
    expect(r.from).toBe(committed + 1);
    expect(r.newLogs).toBeGreaterThan(0);
    expect(await h.ctx.db.betIndex.count({ where: { marketOnchainId: onchainId } })).toBe(1);
  });

  it("detects a chain reorganisation, drops orphaned data and rebuilds from the canonical chain", async () => {
    const { onchainId } = await h.createEventAndMarket(token);
    await h.ctx.indexer.syncToHead();
    const reorgsBefore = (await h.ctx.db.indexerState.findUniqueOrThrow({ where: { id: "main" } })).reorgs;

    const snap = (await h.rpc("evm_snapshot")).result as string;
    const orphan = await h.placeBet(BETTOR, onchainId, 0, "500"); // will be orphaned
    await h.ctx.indexer.syncToHead();
    expect(await h.ctx.db.betIndex.count({ where: { placedTxHash: orphan.hash } })).toBe(1);

    // Revert to before the bet, then mine a DIFFERENT history at the same heights.
    await h.rpc("evm_revert", [snap]);
    const canonical = await h.placeBet(4, onchainId, 1, "33");
    await h.rpc("evm_mine");
    await h.ctx.indexer.syncToHead();

    expect(await h.ctx.db.betIndex.count({ where: { placedTxHash: orphan.hash } })).toBe(0);
    expect(await h.ctx.db.chainLog.count({ where: { txHash: orphan.hash } })).toBe(0);
    expect(await h.ctx.db.betIndex.count({ where: { placedTxHash: canonical.hash } })).toBe(1);
    const st = await h.ctx.db.indexerState.findUniqueOrThrow({ where: { id: "main" } });
    expect(st.reorgs).toBe(reorgsBefore + 1);
    const report = await h.ctx.reconciler.run();
    expect(report.mismatches).toEqual([]);
  });

  it("reconciliation flags a tampered read model", async () => {
    const bet = await h.ctx.db.betIndex.findFirstOrThrow();
    await h.ctx.db.betIndex.update({ where: { betId: bet.betId }, data: { stake: "1" } });
    const report = await h.ctx.reconciler.run();
    expect(report.ok).toBe(false);
    expect(report.mismatches.join("\n")).toContain(`bet #${bet.betId} stake differs`);
    // Rebuilding from the raw chain log repairs it.
    await h.ctx.db.$transaction((tx) => h.ctx.indexer.rebuild(tx), { timeout: 60_000 });
    expect((await h.ctx.reconciler.run()).ok).toBe(true);
  });
});
