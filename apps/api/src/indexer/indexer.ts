import { type Hex, type Log, parseEventLogs } from "viem";
import { WS } from "@fairplay/shared";
import type { ChainCtx } from "../chain.ts";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { Realtime } from "../realtime.ts";
import { applyLog, type Emission, recomputeMarket, type StoredLog, type Tx } from "./projector.ts";

const STATE_ID = "main";
const KEEP_BLOCK_HASHES = 512;

export interface IndexerOptions {
  confirmations: number;
  batchBlocks: number;
  pollMs: number;
  deployBlock: number;
  chainId: number;
}

export interface TickResult {
  from: number;
  to: number;
  logs: number;
  newLogs: number;
  reorg: { ancestor: number } | null;
}

function jsonArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map((x) => (typeof x === "bigint" ? x.toString() : x)) : v;
  }
  return out;
}

/**
 * Polling indexer for BettingMarket + MockOracleAdapter.
 *
 *  • Confirmation depth: only blocks at or below `head - confirmations` are indexed.
 *  • Idempotent: raw logs are unique on (txHash, logIndex); re-processing a range inserts nothing and
 *    projections are re-derived, never incremented.
 *  • Resumable: progress (`lastBlock`) commits in the same DB transaction as the logs it covers.
 *  • Reorg-safe: stored block hashes are compared with the chain every tick. On mismatch it walks back to
 *    the common ancestor, deletes everything above it and rebuilds every projection from the raw log.
 *    A restarted local Anvil (same addresses, different chain) is handled by the same path.
 *
 * Single-writer by design: run one indexer per database.
 */
export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  lastHead = 0;

  constructor(
    private readonly db: Db,
    private readonly chain: ChainCtx,
    private readonly realtime: Realtime,
    private readonly log: Logger,
    private readonly opts: IndexerOptions,
  ) {}

  private get addresses(): Hex[] {
    return [this.chain.contracts.bettingMarket.address, this.chain.contracts.oracleAdapter.address];
  }

  async state() {
    const contract = this.chain.contracts.bettingMarket.address.toLowerCase();
    const existing = await this.db.indexerState.findUnique({ where: { id: STATE_ID } });
    if (existing && existing.contract === contract && existing.chainId === this.opts.chainId) return existing;
    if (existing) {
      this.log.warn({ old: existing.contract, new: contract }, "deployment changed — clearing indexed chain data");
      await this.db.$transaction(async (tx) => this.wipeChainData(tx), { timeout: 60_000 });
    }
    return this.db.indexerState.upsert({
      where: { id: STATE_ID },
      update: { contract, chainId: this.opts.chainId, lastBlock: this.opts.deployBlock - 1, reorgs: 0 },
      create: { id: STATE_ID, contract, chainId: this.opts.chainId, lastBlock: this.opts.deployBlock - 1 },
    });
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        let r: TickResult;
        // Catch up in batches without waiting a poll interval between them.
        do {
          r = await this.tick();
        } while (!this.stopped && r.to - r.from + 1 >= this.opts.batchBlocks);
      } catch (err) {
        this.log.error({ err }, "indexer tick failed");
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.pollMs);
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Index everything up to the current confirmed head (used by tests and the setup script). */
  async syncToHead(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      const r = await this.tick();
      if (!r.reorg && r.to < r.from) return; // nothing left to index
    }
  }

  async tick(): Promise<TickResult> {
    if (this.running) return { from: 0, to: -1, logs: 0, newLogs: 0, reorg: null };
    this.running = true;
    try {
      const state = await this.state();
      const head = Number(await this.chain.publicClient.getBlockNumber());
      this.lastHead = head;
      this.realtime.emit(WS.chainHead, { head, indexed: state.lastBlock });

      const reorg = await this.detectReorg(head);
      if (reorg) {
        await this.handleReorg(reorg.ancestor);
        return { from: reorg.ancestor + 1, to: reorg.ancestor, logs: 0, newLogs: 0, reorg };
      }

      const from = state.lastBlock + 1;
      const target = head - this.opts.confirmations;
      const to = Math.min(target, from + this.opts.batchBlocks - 1);
      if (to < from) return { from, to, logs: 0, newLogs: 0, reorg: null };

      const raw = await this.chain.publicClient.getLogs({ address: this.addresses, fromBlock: BigInt(from), toBlock: BigInt(to) });
      const decoded = this.decode(raw);

      // Fetch the header of every block we will record (blocks with logs + the batch tip).
      const blockNums = new Set<number>(decoded.map((l) => l.blockNumber));
      blockNums.add(to);
      const headers = new Map<number, { hash: string; parentHash: string; timestamp: number }>();
      for (const bn of blockNums) {
        const b = await this.chain.publicClient.getBlock({ blockNumber: BigInt(bn) });
        headers.set(bn, { hash: b.hash!, parentHash: b.parentHash, timestamp: Number(b.timestamp) });
      }
      // A log whose block hash no longer matches means the chain moved under us — retry next tick.
      for (const l of decoded) {
        if (headers.get(l.blockNumber)!.hash !== l.blockHash) {
          this.log.warn({ block: l.blockNumber }, "block changed during fetch; retrying");
          return { from, to: from - 1, logs: 0, newLogs: 0, reorg: null };
        }
      }

      const emissions: Emission[] = [];
      let newLogs = 0;
      await this.db.$transaction(
        async (tx) => {
          const touched = new Set<number>();
          for (const l of decoded) {
            const exists = await tx.chainLog.findUnique({ where: { txHash_logIndex: { txHash: l.txHash, logIndex: l.logIndex } } });
            if (exists) continue;
            const stored: StoredLog = { ...l, timestamp: new Date(headers.get(l.blockNumber)!.timestamp * 1000) };
            await tx.chainLog.create({
              data: {
                blockNumber: l.blockNumber,
                blockHash: l.blockHash,
                txHash: l.txHash,
                logIndex: l.logIndex,
                address: l.address,
                contract: l.contract,
                eventName: l.eventName,
                args: l.args as object,
                timestamp: stored.timestamp,
              },
            });
            await applyLog(tx, stored, touched, emissions);
            newLogs++;
          }
          for (const id of touched) await recomputeMarket(tx, id);
          for (const [number, h] of headers) {
            await tx.indexedBlock.upsert({
              where: { number },
              update: { hash: h.hash, parentHash: h.parentHash },
              create: { number, hash: h.hash, parentHash: h.parentHash },
            });
          }
          await tx.indexedBlock.deleteMany({ where: { number: { lt: to - KEEP_BLOCK_HASHES } } });
          await tx.indexerState.update({ where: { id: STATE_ID }, data: { lastBlock: to } });
        },
        { timeout: 60_000 },
      );
      for (const e of emissions) this.realtime.emit(e.event, e.payload, e.wallet);
      if (newLogs > 0) this.log.info({ from, to, newLogs }, "indexed");
      return { from, to, logs: decoded.length, newLogs, reorg: null };
    } finally {
      this.running = false;
    }
  }

  private decode(raw: Log[]): Array<Omit<StoredLog, "timestamp"> & { blockHash: string; address: string }> {
    const market = this.chain.contracts.bettingMarket;
    const oracle = this.chain.contracts.oracleAdapter;
    const out: Array<Omit<StoredLog, "timestamp"> & { blockHash: string; address: string }> = [];
    const parsed = [
      ...parseEventLogs({ abi: market.abi, logs: raw.filter((l) => l.address.toLowerCase() === market.address.toLowerCase()) }).map(
        (l) => ({ l, contract: "BettingMarket" }),
      ),
      ...parseEventLogs({ abi: oracle.abi, logs: raw.filter((l) => l.address.toLowerCase() === oracle.address.toLowerCase()) }).map(
        (l) => ({ l, contract: "MockOracleAdapter" }),
      ),
    ];
    for (const { l, contract } of parsed) {
      out.push({
        blockNumber: Number(l.blockNumber),
        blockHash: l.blockHash,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        address: l.address.toLowerCase(),
        contract,
        eventName: l.eventName,
        args: jsonArgs(l.args as Record<string, unknown>),
      });
    }
    return out.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  }

  /** Compares stored block hashes (newest first) with the chain; returns the common ancestor on mismatch. */
  private async detectReorg(head: number): Promise<{ ancestor: number } | null> {
    const tip = await this.db.indexedBlock.findFirst({ orderBy: { number: "desc" } });
    if (!tip) return null;
    if ((await this.canonicalHash(tip.number, head)) === tip.hash) return null;

    const stored = await this.db.indexedBlock.findMany({ orderBy: { number: "desc" } });
    for (const b of stored) {
      if ((await this.canonicalHash(b.number, head)) === b.hash) {
        this.log.warn({ tip: tip.number, ancestor: b.number }, "chain reorganisation detected");
        return { ancestor: b.number };
      }
    }
    this.log.warn({ tip: tip.number }, "no common ancestor in stored hashes — full re-index");
    return { ancestor: this.opts.deployBlock - 1 };
  }

  private async canonicalHash(number: number, head: number): Promise<string | null> {
    if (number > head) return null;
    try {
      const b = await this.chain.publicClient.getBlock({ blockNumber: BigInt(number) });
      return b.hash;
    } catch {
      return null;
    }
  }

  /** Drop everything above `ancestor`, then rebuild every projection by replaying the remaining raw log. */
  async handleReorg(ancestor: number): Promise<void> {
    const emissions: Emission[] = [];
    await this.db.$transaction(
      async (tx) => {
        await tx.chainLog.deleteMany({ where: { blockNumber: { gt: ancestor } } });
        await tx.indexedBlock.deleteMany({ where: { number: { gt: ancestor } } });
        await tx.oddsHistory.updateMany({
          where: { blockNumber: { gt: ancestor }, source: { in: ["simulated-engine", "admin"] } },
          data: { status: "PENDING", blockNumber: null, confirmedAt: null, version: null },
        });
        await tx.oddsHistory.deleteMany({ where: { blockNumber: { gt: ancestor }, source: { in: ["initial", "external"] } } });
        await this.rebuild(tx, emissions);
        await tx.indexerState.update({ where: { id: STATE_ID }, data: { lastBlock: ancestor, reorgs: { increment: 1 } } });
      },
      { timeout: 120_000 },
    );
    this.realtime.emit("chain:reorg", { ancestor });
  }

  /** Reset all chain-derived columns and replay ChainLog in order. */
  async rebuild(tx: Tx, emissions: Emission[] = []): Promise<void> {
    await tx.betIndex.deleteMany({});
    await tx.settlement.deleteMany({});
    await tx.oracleReport.deleteMany({});
    await tx.outcome.updateMany({ data: { stake: "0", grossPayout: "0", betCount: 0 } });
    await tx.market.updateMany({
      data: {
        onchainId: null,
        status: "DRAFT",
        totalStake: "0",
        reserved: "0",
        oddsVersion: 0,
        questionId: null,
        winningOutcome: null,
        settledAt: null,
      },
    });
    await tx.event.updateMany({ data: { onchainId: null } });
    const logs = await tx.chainLog.findMany({ orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }] });
    const touched = new Set<number>();
    for (const l of logs) {
      await applyLog(
        tx,
        { ...l, args: l.args as Record<string, unknown> },
        touched,
        emissions,
      );
    }
    for (const id of touched) await recomputeMarket(tx, id);
  }

  private async wipeChainData(tx: Tx) {
    await tx.chainLog.deleteMany({});
    await tx.indexedBlock.deleteMany({});
    await this.rebuild(tx);
  }
}
