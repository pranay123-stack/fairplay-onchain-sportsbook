import type { ChainCtx } from "../chain.ts";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";

/**
 * Housekeeping that anyone could do — both calls below are permissionless on-chain:
 *   • close markets whose kick-off has passed (so their status reads correctly everywhere);
 *   • settle markets whose oracle result is final.
 * Failures back off per market so a market with an unusable result (e.g. reported before close)
 * does not spam transactions; it waits for an admin to cancel it.
 */
export class Keeper {
  private timer: NodeJS.Timeout | null = null;
  private backoff = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly chain: ChainCtx,
    private readonly log: Logger,
    private readonly intervalMs: number,
  ) {}

  start() {
    const loop = async () => {
      await this.step().catch((err) => this.log.warn({ err: (err as Error).message }, "keeper step failed"));
      this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, this.intervalMs);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private shouldSkip(key: string) {
    const until = this.backoff.get(key);
    return until !== undefined && until > Date.now();
  }

  async step(): Promise<{ closed: number; settled: number }> {
    const block = await this.chain.publicClient.getBlock();
    const now = new Date(Number(block.timestamp) * 1000);
    const { abi, address } = this.chain.contracts.bettingMarket;
    const oracle = this.chain.contracts.oracleAdapter;
    let closed = 0;
    let settled = 0;

    const toClose = await this.db.market.findMany({ where: { status: "OPEN", closeTime: { lte: now }, onchainId: { not: null } } });
    for (const m of toClose) {
      if (this.shouldSkip(`close:${m.id}`)) continue;
      try {
        await this.chain.operator.send({ kind: "CLOSE_MARKET", address, abi, functionName: "closeMarket", args: [BigInt(m.onchainId!)], marketId: m.id });
        closed++;
      } catch (err) {
        this.backoff.set(`close:${m.id}`, Date.now() + 60_000);
        this.log.debug({ market: m.onchainId, err: (err as Error).message }, "keeper close skipped");
      }
    }

    const live = await this.db.market.findMany({
      where: { status: { in: ["PENDING", "OPEN", "CLOSED"] }, questionId: { not: null }, onchainId: { not: null } },
    });
    for (const m of live) {
      if (this.shouldSkip(`settle:${m.id}`)) continue;
      const final = await this.chain.publicClient.readContract({
        address: oracle.address,
        abi: oracle.abi,
        functionName: "isFinal",
        args: [m.questionId as `0x${string}`],
      });
      if (!final) continue;
      try {
        await this.chain.operator.send({ kind: "SETTLE_MARKET", address, abi, functionName: "settleMarket", args: [BigInt(m.onchainId!)], marketId: m.id });
        settled++;
      } catch (err) {
        this.backoff.set(`settle:${m.id}`, Date.now() + 120_000);
        this.log.warn({ market: m.onchainId, err: (err as Error).message }, "final result could not be settled — needs admin review");
      }
    }
    return { closed, settled };
  }
}
