import type { FastifyPluginAsync } from "fastify";
import { type Abi, type Hex, decodeFunctionData, parseEventLogs } from "viem";
import { z } from "zod";
import {
  addressSchema,
  listEventsQuerySchema,
  type PlatformStatsDTO,
  type SettlementDTO,
  type TransactionDTO,
  txHashSchema,
  uuidSchema,
} from "@fairplay/shared";
import type { AppContext } from "../context.ts";
import { dec, type Prisma } from "../db.ts";
import { notFound } from "../errors.ts";
import { betDto, eventDto, marketDto, marketInclude, oracleDto, oracleFor } from "../services/serializers.ts";

const idParam = z.object({ id: uuidSchema });

export const publicRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const { db, chain, env } = ctx;
    const d = env.deployment;

    app.get("/health", async () => {
      const [dbOk, head] = await Promise.all([
        db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
        chain.publicClient.getBlockNumber().then(Number).catch(() => null),
      ]);
      return { ok: dbOk && head !== null, db: dbOk, chainHead: head };
    });

    app.get("/config", async () => ({
      chainId: env.CHAIN_ID,
      network: chain.chain.name,
      rpcUrl: env.CHAIN_ID === 31337 ? env.RPC_URL : null,
      explorerUrl: env.EXPLORER_URL ?? null,
      contracts: { bettingMarket: d.bettingMarket, mockUSDC: d.mockUSDC, oracleAdapter: d.oracleAdapter },
      services: { operator: d.operator, reporter: d.reporter, deployer: d.deployer },
      deployBlock: d.deployBlock,
      oracleFinalitySeconds: d.oracleFinalitySeconds,
      feeBps: d.feeBps,
    }));

    app.get("/events", async (req) => {
      const q = listEventsQuerySchema.parse(req.query);
      const now = new Date();
      const where: Prisma.EventWhereInput = {
        ...(q.sport ? { sport: q.sport } : {}),
        ...(q.featured !== undefined ? { featured: q.featured } : {}),
        ...(q.q
          ? {
              OR: [
                { homeTeam: { contains: q.q, mode: "insensitive" } },
                { awayTeam: { contains: q.q, mode: "insensitive" } },
                { league: { contains: q.q, mode: "insensitive" } },
              ],
            }
          : {}),
        ...(q.status === "upcoming" ? { startTime: { gt: now } } : {}),
        ...(q.status === "closed" ? { startTime: { lte: now }, markets: { some: { status: { in: ["OPEN", "CLOSED"] } } } } : {}),
        ...(q.status === "settled" ? { markets: { some: { status: { in: ["SETTLED", "CANCELLED"] } } } } : {}),
      };
      const events = await db.event.findMany({
        where,
        include: { markets: { include: marketInclude, orderBy: { createdAt: "asc" } } },
        orderBy: { startTime: "asc" },
        take: 200,
      });
      const oracles = await oracleFor(db, events.flatMap((e) => e.markets));
      return events.map((e) => eventDto(e, oracles));
    });

    app.get("/events/:id", async (req) => {
      const { id } = idParam.parse(req.params);
      const e = await db.event.findUnique({ where: { id }, include: { markets: { include: marketInclude, orderBy: { createdAt: "asc" } } } });
      if (!e) throw notFound("event");
      return eventDto(e, await oracleFor(db, e.markets));
    });

    app.get("/markets", async (req) => {
      const q = z
        .object({ eventId: uuidSchema.optional(), status: z.enum(["DRAFT", "PENDING", "OPEN", "CLOSED", "SETTLED", "CANCELLED"]).optional() })
        .parse(req.query);
      const markets = await db.market.findMany({
        where: { ...(q.eventId ? { eventId: q.eventId } : {}), ...(q.status ? { status: q.status } : {}) },
        include: marketInclude,
        orderBy: { closeTime: "asc" },
        take: 500,
      });
      const oracles = await oracleFor(db, markets);
      return markets.map((m) => marketDto(m, m.questionId ? oracles.get(m.questionId) : null));
    });

    app.get("/markets/:id", async (req) => {
      const { id } = idParam.parse(req.params);
      const m = await db.market.findUnique({ where: { id }, include: { ...marketInclude, event: true } });
      if (!m) throw notFound("market");
      const [oddsHistory, bets, reports, settlement] = await Promise.all([
        db.oddsHistory.findMany({ where: { marketId: id }, orderBy: { createdAt: "asc" }, take: 200 }),
        db.betIndex.findMany({
          where: { marketId: id },
          include: { market: { include: { outcomes: true, event: true } } },
          orderBy: { betId: "desc" },
          take: 50,
        }),
        m.questionId ? db.oracleReport.findMany({ where: { questionId: m.questionId }, orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }] }) : [],
        m.onchainId !== null ? db.settlement.findUnique({ where: { marketOnchainId: m.onchainId } }) : null,
      ]);
      return {
        ...marketDto(m, reports.at(-1) ?? null),
        event: { id: m.event.id, homeTeam: m.event.homeTeam, awayTeam: m.event.awayTeam, sport: m.event.sport, league: m.event.league, startTime: m.event.startTime.toISOString() },
        oddsHistory: oddsHistory.map((h) => ({
          odds: h.odds,
          version: h.version,
          status: h.status,
          source: h.source,
          txHash: h.txHash,
          createdAt: h.createdAt.toISOString(),
          confirmedAt: h.confirmedAt?.toISOString() ?? null,
        })),
        oracleReports: reports.map(oracleDto),
        settlement: settlement ? settlementDto(settlement, m.title, `${m.event.homeTeam} vs ${m.event.awayTeam}`, m.outcomes) : null,
        recentBets: bets.map(betDto),
      };
    });

    /** Current executable (on-chain-confirmed) odds, plus any pending proposal, for every open market. */
    app.get("/odds", async (req) => {
      const q = z.object({ marketId: uuidSchema.optional() }).parse(req.query);
      const markets = await db.market.findMany({
        where: q.marketId ? { id: q.marketId } : { status: { in: ["OPEN", "PENDING"] } },
        include: marketInclude,
      });
      return markets.map((m) => ({
        marketId: m.id,
        onchainId: m.onchainId,
        status: m.status,
        oddsVersion: m.oddsVersion,
        executable: m.outcomes.map((o) => ({ index: o.index, label: o.label, odds: dec(o.odds) })),
        pending: m.oddsHistory[0] ? { odds: m.oddsHistory[0].odds, txHash: m.oddsHistory[0].txHash, source: m.oddsHistory[0].source } : null,
        simulated: m.simulateOdds,
      }));
    });

    app.get("/bets/:walletAddress", async (req) => {
      const { walletAddress } = z.object({ walletAddress: addressSchema }).parse(req.params);
      const bets = await db.betIndex.findMany({
        where: { bettor: walletAddress.toLowerCase() },
        include: { market: { include: { outcomes: true, event: true } } },
        orderBy: { betId: "desc" },
      });
      return bets.map(betDto);
    });

    app.get("/settlements", async () => {
      const rows = await db.settlement.findMany({ orderBy: { at: "desc" }, take: 100 });
      const markets = await db.market.findMany({
        where: { onchainId: { in: rows.map((r) => r.marketOnchainId) } },
        include: { event: true, outcomes: true },
      });
      const byId = new Map(markets.map((m) => [m.onchainId, m]));
      return rows.map((r) => {
        const m = byId.get(r.marketOnchainId);
        return settlementDto(r, m?.title ?? null, m ? `${m.event.homeTeam} vs ${m.event.awayTeam}` : null, m?.outcomes ?? []);
      });
    });

    /** Raw indexed contract events — what the transparency page and admin "contract events" view show. */
    app.get("/chain-events", async (req) => {
      const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), eventName: z.string().max(40).optional() }).parse(req.query);
      const rows = await db.chainLog.findMany({
        where: q.eventName ? { eventName: q.eventName } : {},
        orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
        take: q.limit,
      });
      return rows.map((r) => ({
        blockNumber: r.blockNumber,
        txHash: r.txHash,
        logIndex: r.logIndex,
        contract: r.contract,
        eventName: r.eventName,
        args: r.args,
        timestamp: r.timestamp.toISOString(),
      }));
    });

    app.get("/transactions/:hash", async (req): Promise<TransactionDTO> => {
      const { hash } = z.object({ hash: txHashSchema }).parse(req.params);
      const h = hash as Hex;
      const explorer = env.EXPLORER_URL ? `${env.EXPLORER_URL.replace(/\/$/, "")}/tx/${hash}` : null;
      const tx = await chain.publicClient.getTransaction({ hash: h }).catch(() => null);
      if (!tx) {
        return { hash, status: "not_found", blockNumber: null, blockHash: null, timestamp: null, from: null, to: null, toLabel: null, gasUsed: null, confirmations: 0, functionName: null, decodedLogs: [], explorerUrl: explorer };
      }
      const receipt = await chain.publicClient.getTransactionReceipt({ hash: h }).catch(() => null);
      const known: Array<{ name: string; address: string; abi: Abi }> = [
        { name: "BettingMarket", address: d.bettingMarket, abi: chain.contracts.bettingMarket.abi },
        { name: "MockUSDC", address: d.mockUSDC, abi: chain.contracts.mockUSDC.abi },
        { name: "MockOracleAdapter", address: d.oracleAdapter, abi: chain.contracts.oracleAdapter.abi },
      ];
      const target = known.find((k) => k.address.toLowerCase() === tx.to?.toLowerCase());
      let functionName: string | null = null;
      if (target) {
        try {
          functionName = decodeFunctionData({ abi: target.abi, data: tx.input }).functionName;
        } catch {
          functionName = null;
        }
      }
      const decodedLogs: TransactionDTO["decodedLogs"] = [];
      if (receipt) {
        for (const k of known) {
          const logs = parseEventLogs({ abi: k.abi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === k.address.toLowerCase()) });
          for (const l of logs) {
            const args: Record<string, string> = {};
            for (const [key, v] of Object.entries((l.args ?? {}) as Record<string, unknown>)) {
              args[key] = Array.isArray(v) ? v.map(String).join(", ") : String(v);
            }
            decodedLogs.push({ contract: k.name, address: l.address, event: l.eventName as string, args });
          }
        }
      }
      const block = receipt ? await chain.publicClient.getBlock({ blockNumber: receipt.blockNumber }) : null;
      const head = await chain.publicClient.getBlockNumber();
      return {
        hash,
        status: receipt ? receipt.status : "pending",
        blockNumber: receipt ? Number(receipt.blockNumber) : null,
        blockHash: receipt?.blockHash ?? null,
        timestamp: block ? new Date(Number(block.timestamp) * 1000).toISOString() : null,
        from: tx.from,
        to: tx.to ?? null,
        toLabel: chain.labelOf(tx.to),
        gasUsed: receipt ? receipt.gasUsed.toString() : null,
        confirmations: receipt ? Number(head - receipt.blockNumber) + 1 : 0,
        functionName,
        decodedLogs,
        explorerUrl: explorer,
      };
    });

    app.get("/platform/stats", async (): Promise<PlatformStatsDTO> => {
      const { address, abi } = chain.contracts.bettingMarket;
      const read = <T>(functionName: string, args: unknown[] = []) =>
        chain.publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;
      const [solvency, houseBalance, totalReserved, openStake, outstandingClaims, accruedFees, feeBps, paused, betCount, marketCount, finality, head] =
        await Promise.all([
          read<readonly [bigint, bigint]>("solvency"),
          read<bigint>("houseBalance"),
          read<bigint>("totalReserved"),
          read<bigint>("openStake"),
          read<bigint>("outstandingClaims"),
          read<bigint>("accruedFees"),
          read<number>("feeBps"),
          read<boolean>("paused"),
          read<bigint>("betCount"),
          read<bigint>("marketCount"),
          chain.publicClient.readContract({ address: d.oracleAdapter, abi: chain.contracts.oracleAdapter.abi, functionName: "finalityDelay" }),
          chain.publicClient.getBlockNumber(),
        ]);
      const [state, events, markets, bets, settled, cancelled, volume] = await Promise.all([
        db.indexerState.findUnique({ where: { id: "main" } }),
        db.event.count(),
        db.market.count({ where: { onchainId: { not: null } } }),
        db.betIndex.count(),
        db.market.count({ where: { status: "SETTLED" } }),
        db.market.count({ where: { status: "CANCELLED" } }),
        db.betIndex.aggregate({ _sum: { stake: true } }),
      ]);
      const r = ctx.reconciler.last;
      const lastIndexed = state?.lastBlock ?? -1;
      return {
        chainId: env.CHAIN_ID,
        network: chain.chain.name,
        contracts: { bettingMarket: d.bettingMarket, mockUSDC: d.mockUSDC, oracleAdapter: d.oracleAdapter },
        deployBlock: d.deployBlock,
        onchain: {
          escrowRequired: solvency[0].toString(),
          escrowHeld: solvency[1].toString(),
          houseBalance: houseBalance.toString(),
          totalReserved: totalReserved.toString(),
          freeLiquidity: (houseBalance - totalReserved).toString(),
          openStake: openStake.toString(),
          outstandingClaims: outstandingClaims.toString(),
          accruedFees: accruedFees.toString(),
          feeBps: Number(feeBps),
          paused,
          betCount: Number(betCount),
          marketCount: Number(marketCount),
          oracleFinalitySeconds: Number(finality),
        },
        indexer: {
          lastIndexedBlock: lastIndexed,
          chainHead: Number(head),
          confirmations: env.INDEXER_CONFIRMATIONS,
          lagBlocks: Math.max(0, Number(head) - lastIndexed),
          reorgsHandled: state?.reorgs ?? 0,
        },
        reconciliation: { ok: r.ok, checkedAt: r.checkedAt, checkedMarkets: r.checkedMarkets, checkedBets: r.checkedBets, mismatches: r.mismatches },
        totals: { events, markets, bets, settledMarkets: settled, cancelledMarkets: cancelled, volume: dec(volume._sum.stake) },
        oddsEngine: {
          enabled: ctx.oddsEngine.enabled,
          intervalSeconds: ctx.oddsEngine.intervalSeconds,
          simulated: true,
        },
      };
    });
  };

function settlementDto(
  r: Prisma.SettlementGetPayload<object>,
  title: string | null,
  eventLabel: string | null,
  outcomes: Array<{ index: number; label: string }>,
): SettlementDTO {
  return {
    marketOnchainId: r.marketOnchainId,
    marketTitle: title,
    eventLabel,
    kind: r.kind as SettlementDTO["kind"],
    winningOutcome: r.winningOutcome,
    winningLabel: r.winningOutcome !== null ? (outcomes.find((o) => o.index === r.winningOutcome)?.label ?? null) : null,
    totalStake: dec(r.totalStake),
    winnersPayout: dec(r.winnersPayout),
    fees: dec(r.fees),
    houseDelta: dec(r.houseDelta),
    oracleReporter: r.oracleReporter,
    resultReportedAt: r.resultReportedAt?.toISOString() ?? null,
    reason: r.reason,
    txHash: r.txHash,
    blockNumber: r.blockNumber,
    at: r.at.toISOString(),
  };
}
