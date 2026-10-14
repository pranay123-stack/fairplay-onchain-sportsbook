import { computePayout, MARKET_STATUS, marketLiability, ORACLE_STATUS, WS } from "@fairplay/shared";
import type { Prisma } from "../generated/prisma/client.ts";

export type Tx = Prisma.TransactionClient;

export interface StoredLog {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  contract: string;
  eventName: string;
  args: Record<string, unknown>;
  timestamp: Date;
}

export interface Emission {
  event: string;
  payload: unknown;
  wallet?: string;
}

const s = (v: unknown) => String(v);
const n = (v: unknown) => Number(v);
const lower = (v: unknown) => String(v).toLowerCase();

/**
 * Applies one decoded contract log to the read model. Must be deterministic given (DB state, log) because
 * it is used both for live indexing and for replaying the whole ChainLog after a reorganisation.
 * Aggregates (stakes, liabilities) are never incremented here — `recomputeMarket` derives them from the
 * bet rows, so applying a log twice can never double-count.
 */
export async function applyLog(tx: Tx, log: StoredLog, touched: Set<number>, out: Emission[]): Promise<void> {
  const a = log.args;
  switch (log.eventName) {
    case "SportEventCreated": {
      const ref = lower(a.ref);
      const onchainId = n(a.eventId);
      const startTime = new Date(n(a.startTime) * 1000);
      const existing = await tx.event.findUnique({ where: { ref } });
      if (existing) {
        await tx.event.update({ where: { ref }, data: { onchainId, startTime, createTxHash: log.txHash } });
        out.push({ event: WS.eventCreated, payload: { id: existing.id, onchainId } });
      } else {
        // Created on-chain without metadata (e.g. directly via cast). Index it honestly as unlabelled.
        const ev = await tx.event.create({
          data: {
            ref,
            onchainId,
            startTime,
            sport: "football",
            league: "Unlabelled on-chain event",
            homeTeam: `On-chain event #${onchainId}`,
            awayTeam: "(no metadata)",
            isDemo: false,
            createTxHash: log.txHash,
          },
        });
        out.push({ event: WS.eventCreated, payload: { id: ev.id, onchainId } });
      }
      return;
    }

    case "MarketCreated": {
      const ref = lower(a.ref);
      const onchainId = n(a.marketId);
      const odds = (a.odds as unknown[]).map(s);
      const ev = await tx.event.findUnique({ where: { onchainId: n(a.eventId) } });
      if (!ev) throw new Error(`MarketCreated for unknown event ${s(a.eventId)} — logs out of order?`);
      const data = {
        onchainId,
        questionId: lower(a.questionId),
        closeTime: new Date(n(a.closeTime) * 1000),
        feeBps: n(a.feeBps),
        outcomeCount: n(a.outcomeCount),
        oddsVersion: 1,
        status: "PENDING",
        createTxHash: log.txHash,
      };
      let market = await tx.market.findUnique({ where: { ref } });
      if (market) {
        market = await tx.market.update({ where: { ref }, data });
      } else {
        market = await tx.market.create({
          data: {
            ...data,
            ref,
            eventId: ev.id,
            type: "MONEYLINE",
            title: `On-chain market #${onchainId}`,
            rules: "No off-chain metadata was registered for this market; outcomes are indexed by number only.",
          },
        });
      }
      for (let i = 0; i < odds.length; i++) {
        await tx.outcome.upsert({
          where: { marketId_index: { marketId: market.id, index: i } },
          update: { odds: odds[i]! },
          create: { marketId: market.id, index: i, label: `Outcome ${i + 1}`, odds: odds[i]! },
        });
      }
      const initial = await tx.oddsHistory.findFirst({ where: { marketId: market.id, txHash: log.txHash } });
      if (!initial) {
        await tx.oddsHistory.create({
          data: {
            marketId: market.id,
            odds,
            version: 1,
            status: "CONFIRMED",
            source: "initial",
            txHash: log.txHash,
            blockNumber: log.blockNumber,
            confirmedAt: log.timestamp,
          },
        });
      }
      touched.add(onchainId);
      out.push({ event: WS.marketCreated, payload: { id: market.id, onchainId } });
      return;
    }

    case "MarketLimits": {
      await tx.market.update({
        where: { onchainId: n(a.marketId) },
        data: { minStake: s(a.minStake), maxStake: s(a.maxStake), maxLiability: s(a.maxLiability) },
      });
      return;
    }

    case "MarketStatusChanged": {
      const onchainId = n(a.marketId);
      const status = MARKET_STATUS[n(a.status)] ?? "PENDING";
      const m = await tx.market.update({
        where: { onchainId },
        data: { status, ...(status === "SETTLED" || status === "CANCELLED" ? { settledAt: log.timestamp } : {}) },
      });
      touched.add(onchainId);
      out.push({ event: WS.marketStatus, payload: { id: m.id, onchainId, status, txHash: log.txHash } });
      return;
    }

    case "OddsUpdated": {
      const onchainId = n(a.marketId);
      const odds = (a.odds as unknown[]).map(s);
      const m = await tx.market.update({ where: { onchainId }, data: { oddsVersion: n(a.version) } });
      for (let i = 0; i < odds.length; i++) {
        await tx.outcome.update({ where: { marketId_index: { marketId: m.id, index: i } }, data: { odds: odds[i]! } });
      }
      const pending = await tx.oddsHistory.findFirst({ where: { txHash: log.txHash, marketId: m.id } });
      if (pending) {
        await tx.oddsHistory.update({
          where: { id: pending.id },
          data: { status: "CONFIRMED", version: n(a.version), blockNumber: log.blockNumber, confirmedAt: log.timestamp, odds },
        });
      } else {
        await tx.oddsHistory.create({
          data: {
            marketId: m.id,
            odds,
            version: n(a.version),
            status: "CONFIRMED",
            source: "external",
            txHash: log.txHash,
            blockNumber: log.blockNumber,
            confirmedAt: log.timestamp,
          },
        });
      }
      out.push({ event: WS.oddsUpdated, payload: { id: m.id, onchainId, version: n(a.version), odds, txHash: log.txHash } });
      return;
    }

    case "BetPlaced": {
      const marketOnchainId = n(a.marketId);
      const bettor = lower(a.bettor);
      const m = await tx.market.findUnique({ where: { onchainId: marketOnchainId } });
      await tx.user.upsert({
        where: { address: bettor },
        update: { lastSeenAt: log.timestamp },
        create: { address: bettor, firstSeenAt: log.timestamp, lastSeenAt: log.timestamp },
      });
      const data = {
        marketOnchainId,
        marketId: m?.id ?? null,
        bettor,
        outcomeIndex: n(a.outcomeId),
        stake: s(a.stake),
        odds: s(a.odds),
        potentialPayout: s(a.potentialPayout),
        placedTxHash: log.txHash,
        placedBlock: log.blockNumber,
        placedAt: log.timestamp,
      };
      await tx.betIndex.upsert({ where: { betId: n(a.betId) }, update: data, create: { betId: n(a.betId), ...data } });
      touched.add(marketOnchainId);
      out.push({
        event: WS.betConfirmed,
        payload: { betId: n(a.betId), marketId: m?.id, onchainId: marketOnchainId, bettor, txHash: log.txHash },
        wallet: bettor,
      });
      return;
    }

    case "MarketSettled": {
      const onchainId = n(a.marketId);
      const m = await tx.market.update({
        where: { onchainId },
        data: { winningOutcome: n(a.winningOutcome), settledAt: log.timestamp },
      });
      const row = {
        kind: "SETTLED",
        winningOutcome: n(a.winningOutcome),
        totalStake: s(a.totalStake),
        winnersPayout: s(a.winnersPayout),
        fees: s(a.fees),
        houseDelta: s(a.houseDelta),
        oracleReporter: lower(a.oracleReporter),
        resultReportedAt: new Date(n(a.resultReportedAt) * 1000),
        reason: null,
        txHash: log.txHash,
        blockNumber: log.blockNumber,
        at: log.timestamp,
      };
      await tx.settlement.upsert({ where: { marketOnchainId: onchainId }, update: row, create: { marketOnchainId: onchainId, ...row } });
      touched.add(onchainId);
      out.push({ event: WS.marketSettled, payload: { id: m.id, onchainId, winningOutcome: n(a.winningOutcome), txHash: log.txHash } });
      return;
    }

    case "MarketCancelled": {
      const onchainId = n(a.marketId);
      const m = await tx.market.findUniqueOrThrow({ where: { onchainId } });
      const row = {
        kind: "CANCELLED",
        winningOutcome: null,
        totalStake: s(a.refundTotal),
        winnersPayout: "0",
        fees: "0",
        houseDelta: "0",
        oracleReporter: null,
        resultReportedAt: null,
        reason: s(a.reason),
        txHash: log.txHash,
        blockNumber: log.blockNumber,
        at: log.timestamp,
      };
      await tx.settlement.upsert({ where: { marketOnchainId: onchainId }, update: row, create: { marketOnchainId: onchainId, ...row } });
      touched.add(onchainId);
      out.push({ event: WS.marketCancelled, payload: { id: m.id, onchainId, reason: s(a.reason), txHash: log.txHash } });
      return;
    }

    case "PayoutClaimed": {
      const betId = n(a.betId);
      const bet = await tx.betIndex.update({
        where: { betId },
        data: {
          claimed: true,
          refund: Boolean(a.refund),
          payoutAmount: s(a.amount),
          claimTxHash: log.txHash,
          claimedAt: log.timestamp,
        },
      });
      out.push({
        event: WS.payoutClaimed,
        payload: { betId, bettor: bet.bettor, amount: s(a.amount), refund: Boolean(a.refund), txHash: log.txHash },
        wallet: bet.bettor,
      });
      return;
    }

    case "ResultReported": {
      const questionId = lower(a.questionId);
      const status = ORACLE_STATUS[n(a.status)] ?? "NONE";
      await tx.oracleReport.upsert({
        where: { txHash_logIndex: { txHash: log.txHash, logIndex: log.logIndex } },
        update: {},
        create: {
          questionId,
          status,
          winningOutcome: status === "RESOLVED" ? n(a.winningOutcome) : null,
          reporter: lower(a.reporter),
          reportedAt: new Date(n(a.reportedAt) * 1000),
          finalAt: new Date(n(a.finalAt) * 1000),
          source: s(a.source),
          txHash: log.txHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        },
      });
      const m = await tx.market.findUnique({ where: { questionId } });
      out.push({
        event: WS.resultReported,
        payload: { id: m?.id, onchainId: m?.onchainId, status, winningOutcome: n(a.winningOutcome), finalAt: n(a.finalAt), txHash: log.txHash },
      });
      return;
    }

    default:
      // LiquidityDeposited/Withdrawn, FeesWithdrawn, FeeBpsSet, OracleAllowed, RoleGranted, Paused, … are kept
      // in ChainLog (shown on the transparency page) but have no projection of their own.
      return;
  }
}

/** Derives every aggregate of one market from its bet rows. Idempotent by construction. */
export async function recomputeMarket(tx: Tx, onchainId: number): Promise<void> {
  const m = await tx.market.findUnique({ where: { onchainId }, include: { outcomes: true } });
  if (!m) return;
  const bets = await tx.betIndex.findMany({ where: { marketOnchainId: onchainId } });
  const stake = new Array<bigint>(m.outcomeCount).fill(0n);
  const gross = new Array<bigint>(m.outcomeCount).fill(0n);
  const count = new Array<number>(m.outcomeCount).fill(0);
  let total = 0n;
  for (const b of bets) {
    const st = BigInt(b.stake.toFixed(0));
    const g = computePayout(st, BigInt(b.odds.toFixed(0)), 0).gross;
    stake[b.outcomeIndex]! += st;
    gross[b.outcomeIndex]! += g;
    count[b.outcomeIndex]! += 1;
    total += st;
  }
  const live = m.status !== "SETTLED" && m.status !== "CANCELLED";
  for (let i = 0; i < m.outcomeCount; i++) {
    await tx.outcome.updateMany({
      where: { marketId: m.id, index: i },
      data: { stake: stake[i]!.toString(), grossPayout: gross[i]!.toString(), betCount: count[i]! },
    });
  }
  await tx.market.update({
    where: { id: m.id },
    data: { totalStake: total.toString(), reserved: live ? marketLiability(gross, total).toString() : "0" },
  });
}
