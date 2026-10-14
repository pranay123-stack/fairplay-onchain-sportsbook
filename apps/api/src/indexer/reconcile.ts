import { MARKET_STATUS } from "@fairplay/shared";
import type { ChainCtx } from "../chain.ts";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";

export interface ReconcileReport {
  ok: boolean;
  checkedAt: string | null;
  atBlock: number | null;
  checkedMarkets: number;
  checkedBets: number;
  mismatches: string[];
}

/**
 * Compares the read model with contract state AT THE INDEXER'S OWN BLOCK, so normal indexing lag never
 * shows up as a false mismatch. Any mismatch is a bug (or tampering with the database) and is surfaced on
 * the transparency page — the contract values are the ones that count.
 */
export class Reconciler {
  last: ReconcileReport = { ok: true, checkedAt: null, atBlock: null, checkedMarkets: 0, checkedBets: 0, mismatches: [] };

  constructor(
    private readonly db: Db,
    private readonly chain: ChainCtx,
    private readonly log: Logger,
  ) {}

  async run(): Promise<ReconcileReport> {
    const state = await this.db.indexerState.findUnique({ where: { id: "main" } });
    if (!state || state.lastBlock < 0) return this.last;
    const blockNumber = BigInt(state.lastBlock);
    const { address, abi } = this.chain.contracts.bettingMarket;
    const read = <T>(functionName: string, args: unknown[] = []) =>
      this.chain.publicClient.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;

    const mismatches: string[] = [];
    const markets = await this.db.market.findMany({ where: { onchainId: { not: null } }, include: { outcomes: true } });
    const chainMarketCount = Number(await read<bigint>("marketCount"));
    if (chainMarketCount !== markets.length) {
      mismatches.push(`market count: db=${markets.length} chain=${chainMarketCount}`);
    }

    for (const m of markets) {
      const c = await read<{
        status: number;
        totalStake: bigint;
        reserved: bigint;
        oddsVersion: number;
        winningOutcome: number;
        questionId: string;
      }>("getMarket", [BigInt(m.onchainId!)]);
      const tag = `market #${m.onchainId}`;
      const status = MARKET_STATUS[c.status];
      if (status !== m.status) mismatches.push(`${tag} status: db=${m.status} chain=${status}`);
      if (c.totalStake.toString() !== m.totalStake.toFixed(0)) mismatches.push(`${tag} totalStake: db=${m.totalStake.toFixed(0)} chain=${c.totalStake}`);
      if (c.reserved.toString() !== m.reserved.toFixed(0)) mismatches.push(`${tag} reserved: db=${m.reserved.toFixed(0)} chain=${c.reserved}`);
      if (c.oddsVersion !== m.oddsVersion) mismatches.push(`${tag} oddsVersion: db=${m.oddsVersion} chain=${c.oddsVersion}`);
      if (c.questionId.toLowerCase() !== m.questionId) mismatches.push(`${tag} questionId differs`);
      if (status === "SETTLED" && c.winningOutcome !== m.winningOutcome) {
        mismatches.push(`${tag} winner: db=${m.winningOutcome} chain=${c.winningOutcome}`);
      }
      for (const o of m.outcomes) {
        const co = await read<{ odds: bigint; stake: bigint; betCount: number }>("getOutcome", [BigInt(m.onchainId!), BigInt(o.index)]);
        if (co.odds.toString() !== o.odds.toFixed(0)) mismatches.push(`${tag}/${o.index} odds: db=${o.odds.toFixed(0)} chain=${co.odds}`);
        if (co.stake.toString() !== o.stake.toFixed(0)) mismatches.push(`${tag}/${o.index} stake: db=${o.stake.toFixed(0)} chain=${co.stake}`);
        if (co.betCount !== o.betCount) mismatches.push(`${tag}/${o.index} betCount: db=${o.betCount} chain=${co.betCount}`);
      }
    }

    const bets = await this.db.betIndex.findMany({ orderBy: { betId: "asc" } });
    const chainBetCount = Number(await read<bigint>("betCount"));
    if (chainBetCount !== bets.length) mismatches.push(`bet count: db=${bets.length} chain=${chainBetCount}`);
    for (const b of bets) {
      const c = await read<{ bettor: string; stake: bigint; odds: bigint; potentialPayout: bigint; claimed: boolean; outcomeId: bigint }>(
        "getBet",
        [BigInt(b.betId)],
      );
      const tag = `bet #${b.betId}`;
      if (c.bettor.toLowerCase() !== b.bettor) mismatches.push(`${tag} bettor differs`);
      if (c.stake.toString() !== b.stake.toFixed(0)) mismatches.push(`${tag} stake differs`);
      if (c.odds.toString() !== b.odds.toFixed(0)) mismatches.push(`${tag} odds differs`);
      if (c.potentialPayout.toString() !== b.potentialPayout.toFixed(0)) mismatches.push(`${tag} payout differs`);
      if (c.claimed !== b.claimed) mismatches.push(`${tag} claimed: db=${b.claimed} chain=${c.claimed}`);
      if (Number(c.outcomeId) !== b.outcomeIndex) mismatches.push(`${tag} outcome differs`);
    }

    this.last = {
      ok: mismatches.length === 0,
      checkedAt: new Date().toISOString(),
      atBlock: state.lastBlock,
      checkedMarkets: markets.length,
      checkedBets: bets.length,
      mismatches: mismatches.slice(0, 50),
    };
    if (!this.last.ok) this.log.error({ mismatches: this.last.mismatches }, "reconciliation mismatch");
    return this.last;
  }
}
