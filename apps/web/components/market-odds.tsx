"use client";
import { motion } from "framer-motion";
import type { EventDTO, MarketDTO } from "@fairplay/shared";
import { computePayout, formatOdds, formatUsdc, parseUsdc } from "@fairplay/shared";
import { useBetSlip } from "@/lib/store";
import { cn } from "@/lib/utils";

function safeStake(s: string) {
  try {
    return parseUsdc(s);
  } catch {
    return 0n;
  }
}

/** One outcome's price. Shows the gross return on the slip's current stake; the slip shows exact net. */
export function OddsButton({ event, market, index, compact = false }: { event: EventDTO; market: MarketDTO; index: number; compact?: boolean }) {
  const o = market.outcomes[index]!;
  const { selection, select, stake } = useBetSlip();
  const selected = selection?.marketId === market.id && selection.outcomeIndex === index;
  const bettable = market.status === "OPEN" && new Date(market.closeTime).getTime() > Date.now();
  const pendingOdds = market.pendingOdds?.odds[index];
  const isWinner = market.status === "SETTLED" && market.winningOutcome === index;
  const ret = computePayout(safeStake(stake), BigInt(o.odds), market.feeBps).net;

  return (
    <button
      type="button"
      disabled={!bettable}
      onClick={() =>
        select({
          eventId: event.id,
          marketId: market.id,
          marketOnchainId: market.onchainId!,
          outcomeIndex: index,
          outcomeLabel: o.label,
          marketTitle: market.title,
          eventLabel: `${event.homeTeam} vs ${event.awayTeam}`,
          displayedOdds: o.odds,
        })
      }
      data-testid={`odds-${market.onchainId}-${index}`}
      className={cn(
        "group relative flex min-w-0 flex-1 flex-col items-start rounded-lg border px-3 py-2 text-left transition-[border-color,background-color]",
        selected ? "border-accent bg-accent-dim" : "border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3",
        !bettable && "cursor-not-allowed opacity-60 hover:border-line hover:bg-surface-2",
        isWinner && "border-accent/70 opacity-100",
      )}
    >
      <span className="w-full truncate text-[11px] text-muted">{o.label}</span>
      <span className="flex items-baseline gap-1.5">
        <motion.span
          key={o.odds}
          initial={{ opacity: 0.3, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn("font-mono text-base font-semibold tabular", selected ? "text-accent-bright" : "text-fg")}
        >
          {formatOdds(o.odds)}
        </motion.span>
        {pendingOdds && pendingOdds !== o.odds ? (
          <span className="font-mono text-[10px] text-warn" title="Simulated odds update pending on-chain confirmation — not yet executable">
            → {formatOdds(pendingOdds)}
          </span>
        ) : null}
      </span>
      {!compact && bettable ? (
        <span className="font-mono text-[10px] text-faint tabular">
          {formatUsdc(safeStake(stake), 0)} → {formatUsdc(ret)}
        </span>
      ) : null}
      {isWinner ? <span className="mt-0.5 text-[10px] font-medium text-accent-bright">Winner</span> : null}
    </button>
  );
}

export function marketCapacity(market: MarketDTO, freeLiquidity?: string) {
  const headroom = BigInt(market.maxLiability) - BigInt(market.reserved);
  if (freeLiquidity === undefined) return headroom;
  const free = BigInt(freeLiquidity);
  return headroom < free ? headroom : free;
}
