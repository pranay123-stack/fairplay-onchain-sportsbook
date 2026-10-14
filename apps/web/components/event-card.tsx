"use client";
import { ArrowUpRight, CircleDot, Gamepad2, Trophy } from "lucide-react";
import Link from "next/link";
import { formatUsdc, MARKET_TYPE_LABEL, type EventDTO } from "@fairplay/shared";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { Countdown } from "./countdown";
import { marketCapacity, OddsButton } from "./market-odds";
import { MarketStatusBadge } from "./status";

export const SportIcon = ({ sport, className = "size-3.5" }: { sport: string; className?: string }) =>
  sport === "esports" ? <Gamepad2 className={className} /> : sport === "basketball" ? <Trophy className={className} /> : <CircleDot className={className} />;

export function EventCard({ event, freeLiquidity }: { event: EventDTO; freeLiquidity?: string }) {
  const primary = event.markets.find((m) => m.featured) ?? event.markets[0];
  const started = new Date(event.startTime).getTime() <= Date.now();
  return (
    <article className="group flex flex-col rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] transition-colors hover:border-line-strong" data-testid="event-card">
      <div className="mb-3 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <SportIcon sport={event.sport} />
          <span className="truncate">{event.league}</span>
        </span>
        {event.isDemo ? <Badge>Demo data</Badge> : <Badge tone="warn">Unlabelled</Badge>}
      </div>

      <Link href={`/events/${event.id}`} className="mb-3 block">
        <h3 className="flex items-center gap-1 text-[15px] font-semibold leading-snug tracking-tight">
          <span className="truncate">{event.homeTeam}</span>
          <span className="shrink-0 text-faint">vs</span>
          <span className="truncate">{event.awayTeam}</span>
          <ArrowUpRight className="ml-auto size-4 shrink-0 text-faint transition-colors group-hover:text-accent-bright" />
        </h3>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
          <span suppressHydrationWarning>{formatDateTime(event.startTime)}</span>
          <span className="text-faint">·</span>
          {started ? <span className="text-warn">Started</span> : <Countdown to={event.startTime} className="text-fg" />}
        </div>
      </Link>

      {primary ? (
        <div className="mt-auto">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-[11px] font-medium uppercase tracking-wider text-faint">{MARKET_TYPE_LABEL[primary.type] ?? primary.title}</span>
            <MarketStatusBadge status={primary.status} />
          </div>
          <div className="flex gap-1.5">
            {primary.outcomes.map((o) => (
              <OddsButton key={o.index} event={event} market={primary} index={o.index} />
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
            <span title="Additional liability this market can still accept (min of its cap and the house's free liquidity)">
              Capacity <span className="font-mono text-fg tabular">{formatUsdc(marketCapacity(primary, freeLiquidity), 0)}</span> mUSDC
            </span>
            <Link href={`/events/${event.id}`} className="font-medium text-accent-bright hover:underline">
              {event.markets.length} market{event.markets.length === 1 ? "" : "s"} →
            </Link>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted">No markets yet.</p>
      )}
    </article>
  );
}
