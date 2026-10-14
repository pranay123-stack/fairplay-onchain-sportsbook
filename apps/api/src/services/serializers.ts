import type { BetDTO, BetStatus, EventDTO, MarketDTO, MarketLifecycle, MarketType, OracleResultDTO, Sport } from "@fairplay/shared";
import { dec } from "../db.ts";
import type { Prisma } from "../generated/prisma/client.ts";

export const marketInclude = {
  outcomes: { orderBy: { index: "asc" } },
  oddsHistory: { where: { status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 1 },
  _count: { select: { bets: true } },
} satisfies Prisma.MarketInclude;

export type MarketRow = Prisma.MarketGetPayload<{ include: typeof marketInclude }>;
export type OracleRow = Prisma.OracleReportGetPayload<object>;

export function oracleDto(r: OracleRow | undefined | null): OracleResultDTO | null {
  if (!r) return null;
  return {
    status: r.status as OracleResultDTO["status"],
    winningOutcome: r.winningOutcome,
    reporter: r.reporter,
    reportedAt: r.reportedAt.toISOString(),
    finalAt: r.finalAt.toISOString(),
    source: r.source,
    txHash: r.txHash,
  };
}

export function marketDto(m: MarketRow, oracle?: OracleRow | null): MarketDTO {
  const pending = m.oddsHistory[0];
  return {
    id: m.id,
    onchainId: m.onchainId,
    eventId: m.eventId,
    type: m.type as MarketType,
    title: m.title,
    rules: m.rules,
    status: m.status as MarketLifecycle,
    outcomes: m.outcomes.map((o) => ({
      index: o.index,
      label: o.label,
      odds: dec(o.odds),
      stake: dec(o.stake),
      grossPayout: dec(o.grossPayout),
      betCount: o.betCount,
    })),
    closeTime: m.closeTime.toISOString(),
    feeBps: m.feeBps,
    minStake: dec(m.minStake),
    maxStake: dec(m.maxStake),
    maxLiability: dec(m.maxLiability),
    totalStake: dec(m.totalStake),
    reserved: dec(m.reserved),
    oddsVersion: m.oddsVersion,
    questionId: m.questionId,
    winningOutcome: m.winningOutcome,
    settledAt: m.settledAt?.toISOString() ?? null,
    featured: m.featured,
    createTxHash: m.createTxHash,
    pendingOdds: pending
      ? {
          odds: pending.odds,
          txHash: pending.txHash,
          proposedAt: pending.createdAt.toISOString(),
          source: pending.source === "admin" ? "admin" : "simulated-engine",
        }
      : null,
    oracleResult: oracleDto(oracle),
    betCount: m._count.bets,
  };
}

/** Latest oracle report per questionId for a set of markets. */
export async function oracleFor(db: Prisma.TransactionClient | { oracleReport: Prisma.TransactionClient["oracleReport"] }, markets: Array<{ questionId: string | null }>) {
  const qids = markets.map((m) => m.questionId).filter((q): q is string => !!q);
  if (qids.length === 0) return new Map<string, OracleRow>();
  const rows = await db.oracleReport.findMany({ where: { questionId: { in: qids } }, orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }] });
  const map = new Map<string, OracleRow>();
  for (const r of rows) map.set(r.questionId, r); // later rows (corrections) win
  return map;
}

type EventRow = Prisma.EventGetPayload<{ include: { markets: { include: typeof marketInclude } } }>;

export function eventDto(e: EventRow, oracles: Map<string, OracleRow>): EventDTO {
  return {
    id: e.id,
    onchainId: e.onchainId,
    sport: e.sport as Sport,
    league: e.league,
    homeTeam: e.homeTeam,
    awayTeam: e.awayTeam,
    venue: e.venue,
    description: e.description,
    startTime: e.startTime.toISOString(),
    featured: e.featured,
    isDemo: e.isDemo,
    createTxHash: e.createTxHash,
    markets: e.markets.map((m) => marketDto(m, m.questionId ? oracles.get(m.questionId) : null)),
  };
}

type BetRow = Prisma.BetIndexGetPayload<{
  include: { market: { include: { outcomes: true; event: true } } };
}>;

/** Same derivation as BettingMarket.betStatus(). */
export function betStatus(b: { claimed: boolean; outcomeIndex: number }, m: { status: string; winningOutcome: number | null } | null): BetStatus {
  if (b.claimed) return "CLAIMED";
  if (!m) return "OPEN";
  if (m.status === "CANCELLED") return "REFUNDABLE";
  if (m.status !== "SETTLED") return "OPEN";
  return b.outcomeIndex === m.winningOutcome ? "WON" : "LOST";
}

export function betDto(b: BetRow): BetDTO {
  const m = b.market;
  return {
    betId: b.betId,
    bettor: b.bettor,
    marketId: b.marketId,
    eventId: m?.eventId ?? null,
    marketOnchainId: b.marketOnchainId,
    marketTitle: m?.title ?? null,
    eventLabel: m ? `${m.event.homeTeam} vs ${m.event.awayTeam}` : null,
    outcomeIndex: b.outcomeIndex,
    outcomeLabel: m?.outcomes.find((o) => o.index === b.outcomeIndex)?.label ?? null,
    stake: dec(b.stake),
    odds: dec(b.odds),
    potentialPayout: dec(b.potentialPayout),
    status: betStatus(b, m),
    claimed: b.claimed,
    refund: b.refund,
    payoutAmount: b.payoutAmount ? dec(b.payoutAmount) : null,
    placedTxHash: b.placedTxHash,
    placedBlock: b.placedBlock,
    placedAt: b.placedAt.toISOString(),
    claimTxHash: b.claimTxHash,
  };
}
