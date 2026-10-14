import { randomUUID } from "node:crypto";
import { type Hex, keccak256, parseEventLogs, toHex } from "viem";
import {
  MARKET_STATUS,
  type CreateEventInput,
  type CreateMarketInput,
  type PatchMarketInput,
  parseOdds,
  parseUsdc,
  WS,
} from "@fairplay/shared";
import type { ChainCtx } from "../chain.ts";
import { TxError } from "../chain.ts";
import type { Db } from "../db.ts";
import { AppError, conflict, notFound } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Realtime } from "../realtime.ts";

export interface AuditCtx {
  address: string;
  ip?: string;
}

/** Off-chain metadata id → the bytes32 `ref` that links it to the on-chain object. */
export const refFor = (kind: "event" | "market", id: string): Hex => keccak256(toHex(`fairplay:${kind}:${id}`));

/**
 * Every admin action that changes chain state. The contract enforces the roles of the service keys that
 * sign these transactions; the route layer has already checked the human admin's own on-chain role.
 */
export class MarketService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainCtx,
    private readonly realtime: Realtime,
    private readonly log: Logger,
  ) {}

  private async audit<T>(ctx: AuditCtx, action: string, target: string | null, params: unknown, fn: () => Promise<T & { txHash?: string | null }>) {
    try {
      const result = await fn();
      await this.db.adminAuditLog.create({
        data: { address: ctx.address, action, target, params: params as object, txHash: result.txHash ?? null, outcome: "OK", ip: ctx.ip ?? null },
      });
      return result;
    } catch (err) {
      const e = err as Error & { txHash?: string };
      await this.db.adminAuditLog.create({
        data: {
          address: ctx.address,
          action,
          target,
          params: params as object,
          txHash: err instanceof TxError ? (err.txHash ?? null) : null,
          outcome: "FAILED",
          error: e.message.slice(0, 500),
          ip: ctx.ip ?? null,
        },
      });
      throw err;
    }
  }

  /** `minLeadSeconds` exists for the demo seeder's short "already played" fixtures; the API always uses 60. */
  async createEvent(ctx: AuditCtx, input: CreateEventInput, opts: { minLeadSeconds?: number } = {}) {
    return this.audit(ctx, "CREATE_EVENT", null, input, async () => {
      const start = new Date(input.startTime);
      const lead = opts.minLeadSeconds ?? 60;
      if (start.getTime() <= (await this.nowMs()) + lead * 1000) {
        throw new AppError(400, "START_TOO_SOON", `start time must be at least ${lead}s in the future`);
      }
      const id = randomUUID();
      const ref = refFor("event", id);
      await this.db.event.create({
        data: {
          id,
          ref,
          sport: input.sport,
          league: input.league,
          homeTeam: input.homeTeam,
          awayTeam: input.awayTeam,
          venue: input.venue ?? null,
          description: input.description ?? null,
          startTime: start,
          featured: input.featured,
          isDemo: true,
        },
      });
      const { abi, address } = this.chain.contracts.bettingMarket;
      const { hash, receipt } = await this.chain.operator.send({
        kind: "CREATE_EVENT",
        address,
        abi,
        functionName: "createEvent",
        args: [ref, BigInt(Math.floor(start.getTime() / 1000))],
      });
      // The receipt is chain data, so recording the id here is equivalent to what the indexer will write.
      const [log] = parseEventLogs({ abi, eventName: "SportEventCreated", logs: receipt.logs });
      const onchainId = log ? Number(log.args.eventId) : null;
      const ev = await this.db.event.update({ where: { id }, data: { onchainId, createTxHash: hash } });
      this.realtime.emit(WS.eventCreated, { id, onchainId, txHash: hash });
      return { event: ev, txHash: hash };
    });
  }

  async createMarket(ctx: AuditCtx, input: CreateMarketInput & { simulateOdds?: boolean; featured?: boolean }) {
    return this.audit(ctx, "CREATE_MARKET", input.eventId, input, async () => {
      const ev = await this.db.event.findUnique({ where: { id: input.eventId } });
      if (!ev) throw notFound("event");
      if (ev.onchainId === null) throw conflict("EVENT_NOT_ONCHAIN", "the event's on-chain transaction has not confirmed yet");
      const minStake = parseUsdc(input.minStake);
      const maxStake = parseUsdc(input.maxStake);
      if (maxStake < minStake) throw new AppError(400, "INVALID_STAKE_LIMITS", "maxStake must be ≥ minStake");
      const odds = input.outcomes.map((o) => parseOdds(o.odds));
      const id = randomUUID();
      const ref = refFor("market", id);
      await this.db.market.create({
        data: {
          id,
          ref,
          eventId: ev.id,
          type: input.type,
          title: input.title,
          rules: input.rules,
          featured: input.featured ?? false,
          simulateOdds: input.simulateOdds ?? false,
          outcomeCount: input.outcomes.length,
          closeTime: ev.startTime,
          outcomes: { create: input.outcomes.map((o, i) => ({ index: i, label: o.label, odds: odds[i]!.toString() })) },
        },
      });
      const { abi, address } = this.chain.contracts.bettingMarket;
      const { hash, receipt } = await this.chain.operator.send({
        kind: "CREATE_MARKET",
        address,
        abi,
        functionName: "createMarket",
        args: [
          {
            eventId: BigInt(ev.onchainId),
            ref,
            outcomeCount: input.outcomes.length,
            initialOdds: odds,
            minStake,
            maxStake,
            maxLiability: parseUsdc(input.maxLiability),
            oracle: this.chain.contracts.oracleAdapter.address,
          },
        ],
        marketId: id,
      });
      const [log] = parseEventLogs({ abi, eventName: "MarketCreated", logs: receipt.logs });
      const onchainId = Number(log!.args.marketId);
      // Receipt data is chain data: the indexer will write exactly the same values when it reaches this block.
      await this.db.market.update({
        where: { id },
        data: { createTxHash: hash, onchainId, questionId: log!.args.questionId.toLowerCase() },
      });
      let openTxHash: string | null = null;
      if (input.openImmediately) {
        const r = await this.chain.operator.send({
          kind: "OPEN_MARKET",
          address,
          abi,
          functionName: "openMarket",
          args: [BigInt(onchainId)],
          marketId: id,
        });
        openTxHash = r.hash;
      }
      return { marketId: id, onchainId, txHash: hash, openTxHash };
    });
  }

  /** The contract only knows chain time; on a local chain it can run ahead of the wall clock. */
  private async nowMs(): Promise<number> {
    const block = await this.chain.publicClient.getBlock();
    return Math.max(Date.now(), Number(block.timestamp) * 1000);
  }

  private async onchainMarket(id: string) {
    const m = await this.db.market.findUnique({ where: { id }, include: { outcomes: true } });
    if (!m) throw notFound("market");
    if (m.onchainId === null || !m.questionId) throw conflict("MARKET_NOT_INDEXED", "market is not confirmed on-chain yet");
    return m as typeof m & { onchainId: number; questionId: string };
  }

  /** Propose new odds and send them on-chain. They are PENDING (not executable) until the indexer confirms. */
  async proposeOdds(id: string, odds: bigint[], source: "admin" | "simulated-engine") {
    const m = await this.onchainMarket(id);
    if (odds.length !== m.outcomeCount) throw new AppError(400, "OUTCOME_COUNT", `expected ${m.outcomeCount} odds`);
    const row = await this.db.oddsHistory.create({
      data: { marketId: id, odds: odds.map(String), status: "PENDING", source },
    });
    this.realtime.emit(WS.oddsPending, { id, onchainId: m.onchainId, odds: odds.map(String), source, historyId: row.id });
    const { abi, address } = this.chain.contracts.bettingMarket;
    try {
      const { hash } = await this.chain.operator.send({
        kind: "SET_ODDS",
        address,
        abi,
        functionName: "setOdds",
        args: [BigInt(m.onchainId), odds],
        marketId: id,
        onSubmitted: async (h) => {
          await this.db.oddsHistory.update({ where: { id: row.id }, data: { txHash: h } });
        },
      });
      return { txHash: hash, historyId: row.id };
    } catch (err) {
      await this.db.oddsHistory.update({ where: { id: row.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 300) } });
      this.realtime.emit(WS.oddsUpdated, { id, onchainId: m.onchainId, failed: true });
      throw err;
    }
  }

  async patchMarket(ctx: AuditCtx, id: string, input: PatchMarketInput) {
    return this.audit(ctx, "UPDATE_MARKET", id, input, async () => {
      const m = await this.db.market.findUnique({ where: { id } });
      if (!m) throw notFound("market");
      await this.db.market.update({
        where: { id },
        data: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.rules ? { rules: input.rules } : {}),
          ...(input.featured !== undefined ? { featured: input.featured } : {}),
        },
      });
      let txHash: string | null = null;
      if (input.odds) {
        txHash = (await this.proposeOdds(id, input.odds.map(parseOdds), "admin")).txHash;
      }
      if (input.status === "OPEN") {
        const om = await this.onchainMarket(id);
        const { abi, address } = this.chain.contracts.bettingMarket;
        const fn = om.status === "CLOSED" ? "reopenMarket" : "openMarket";
        txHash = (
          await this.chain.operator.send({ kind: fn === "openMarket" ? "OPEN_MARKET" : "REOPEN_MARKET", address, abi, functionName: fn, args: [BigInt(om.onchainId)], marketId: id })
        ).hash;
      }
      return { txHash };
    });
  }

  async closeMarket(ctx: AuditCtx, id: string) {
    return this.audit(ctx, "CLOSE_MARKET", id, {}, async () => {
      const m = await this.onchainMarket(id);
      const { abi, address } = this.chain.contracts.bettingMarket;
      const { hash } = await this.chain.operator.send({ kind: "CLOSE_MARKET", address, abi, functionName: "closeMarket", args: [BigInt(m.onchainId)], marketId: id });
      return { txHash: hash };
    });
  }

  /** Publishes the result through the MOCK oracle (admin-attested). Settlement happens after finality. */
  async resolve(ctx: AuditCtx, id: string, winningOutcome: number, source: string) {
    return this.audit(ctx, "RESOLVE_MARKET", id, { winningOutcome, source }, async () => {
      const m = await this.onchainMarket(id);
      if (winningOutcome >= m.outcomeCount) throw new AppError(400, "INVALID_OUTCOME", `market has ${m.outcomeCount} outcomes`);
      // Pre-check against the CONTRACT, not the read model: right after a close the indexer may lag.
      const onchain = await this.chain.publicClient.readContract({
        address: this.chain.contracts.bettingMarket.address,
        abi: this.chain.contracts.bettingMarket.abi,
        functionName: "getMarket",
        args: [BigInt(m.onchainId)],
      });
      const status = MARKET_STATUS[onchain.status];
      if (status === "SETTLED" || status === "CANCELLED") throw conflict("MARKET_FINISHED", `market is already ${status.toLowerCase()}`);
      if (status !== "CLOSED" && Number(onchain.closeTime) * 1000 > (await this.nowMs())) {
        throw conflict("MARKET_NOT_CLOSED", "close the market (or wait for kick-off) before publishing a result — results reported before close are rejected on-chain");
      }
      const { abi, address } = this.chain.contracts.oracleAdapter;
      const { hash } = await this.chain.reporter.send({
        kind: "REPORT_RESULT",
        address,
        abi,
        functionName: "reportResult",
        args: [m.questionId as Hex, winningOutcome, source],
        marketId: id,
      });
      return { txHash: hash };
    });
  }

  async cancel(ctx: AuditCtx, id: string, reason: string, via: "oracle" | "manager") {
    return this.audit(ctx, via === "oracle" ? "CANCEL_VIA_ORACLE" : "CANCEL_MARKET", id, { reason, via }, async () => {
      const m = await this.onchainMarket(id);
      if (via === "oracle") {
        const { abi, address } = this.chain.contracts.oracleAdapter;
        const { hash } = await this.chain.reporter.send({
          kind: "REPORT_CANCELLATION",
          address,
          abi,
          functionName: "reportCancellation",
          args: [m.questionId as Hex, reason],
          marketId: id,
        });
        return { txHash: hash };
      }
      const { abi, address } = this.chain.contracts.bettingMarket;
      const { hash } = await this.chain.operator.send({
        kind: "CANCEL_MARKET",
        address,
        abi,
        functionName: "cancelMarket",
        args: [BigInt(m.onchainId), reason],
        marketId: id,
      });
      return { txHash: hash };
    });
  }

  /** Permissionless on-chain; exposed so the keeper (and the admin UI) can trigger it. */
  async settle(id: string) {
    const m = await this.onchainMarket(id);
    const { abi, address } = this.chain.contracts.bettingMarket;
    return this.chain.operator.send({ kind: "SETTLE_MARKET", address, abi, functionName: "settleMarket", args: [BigInt(m.onchainId)], marketId: id });
  }
}
