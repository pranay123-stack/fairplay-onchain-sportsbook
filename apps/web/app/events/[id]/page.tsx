"use client";
import { ChevronDown, Clock, FileCheck2, Gavel, MapPin } from "lucide-react";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { formatOdds, formatUsdc, MARKET_TYPE_LABEL, type EventDTO, type MarketDTO } from "@fairplay/shared";
import { BetSlipPanel } from "@/components/bet-slip";
import { Countdown } from "@/components/countdown";
import { SportIcon } from "@/components/event-card";
import { marketCapacity, OddsButton } from "@/components/market-odds";
import { OddsChart } from "@/components/odds-chart";
import { BetStatusBadge, MarketStatusBadge } from "@/components/status";
import { TxLink } from "@/components/tx-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppConfig, useEvent, useMarket, useStats } from "@/lib/api";
import { cn, formatDateTime, relativeTime, shortAddr, shortHash } from "@/lib/utils";

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: event, isLoading, error } = useEvent(id);
  const { data: stats } = useStats();
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (event && !focus) setFocus(event.markets[0]?.id ?? null);
  }, [event, focus]);

  if (error) return <p className="text-sm text-danger">Event not found or API unreachable.</p>;
  if (isLoading || !event) return <Skeleton className="h-96 w-full rounded-[var(--radius-card)]" />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-5">
        <EventHeader event={event} />
        {event.markets.map((m) => (
          <MarketPanel key={m.id} event={event} market={m} free={stats?.onchain.freeLiquidity} focused={focus === m.id} onFocus={() => setFocus(m.id)} />
        ))}
        {focus ? <MarketActivity marketId={focus} /> : null}
      </div>
      <aside className="hidden lg:block">
        <div className="sticky top-32 space-y-4">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-3 text-sm font-semibold">Bet slip</div>
            <BetSlipPanel />
          </Card>
          <OnchainRefs event={event} />
        </div>
      </aside>
      <div className="lg:hidden">
        <OnchainRefs event={event} />
      </div>
    </div>
  );
}

function EventHeader({ event }: { event: EventDTO }) {
  const started = new Date(event.startTime).getTime() <= Date.now();
  return (
    <Card className="relative overflow-hidden">
      <div className="hero-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
      <div className="relative p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
          <Link href="/" className="hover:text-fg">Markets</Link>
          <span className="text-faint">/</span>
          <span className="inline-flex items-center gap-1.5">
            <SportIcon sport={event.sport} /> {event.league}
          </span>
          {event.isDemo ? <Badge>Fictional demo fixture</Badge> : <Badge tone="warn">No off-chain metadata</Badge>}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {event.homeTeam} <span className="text-faint">vs</span> {event.awayTeam}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted">
          <span className="inline-flex items-center gap-1.5" suppressHydrationWarning>
            <Clock className="size-4" /> {formatDateTime(event.startTime)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {started ? <span className="text-warn">Kick-off passed — betting closed</span> : <>Kick-off in <Countdown to={event.startTime} className="text-fg" /></>}
          </span>
          {event.venue ? (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="size-4" /> {event.venue}
            </span>
          ) : null}
        </div>
        {event.description ? <p className="mt-3 text-xs text-faint">{event.description}</p> : null}
      </div>
    </Card>
  );
}

function MarketPanel({ event, market, free, focused, onFocus }: { event: EventDTO; market: MarketDTO; free?: string; focused: boolean; onFocus: () => void }) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const cols = market.outcomes.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <Card className={cn("transition-colors", focused && "border-line-strong")} onMouseEnter={onFocus} data-testid="market-panel">
      <CardHeader>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-faint">{MARKET_TYPE_LABEL[market.type]}</p>
          <CardTitle className="mt-0.5 text-base">{market.title}</CardTitle>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <MarketStatusBadge status={market.status} />
          <span className="font-mono text-[10px] text-faint">market #{market.onchainId ?? "—"} · odds v{market.oddsVersion}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={cn("grid grid-cols-2 gap-2", cols)}>
          {market.outcomes.map((o) => (
            <OddsButton key={o.index} event={event} market={market} index={o.index} />
          ))}
        </div>
        {market.pendingOdds ? (
          <p className="rounded-md border border-warn/30 bg-warn-dim/50 px-3 py-2 text-xs text-warn">
            Simulated odds update pending on-chain confirmation: {market.pendingOdds.odds.map((o) => formatOdds(o)).join(" / ")}. Shown prices stay executable until it confirms.
          </p>
        ) : null}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Metric label="Total staked" value={`${formatUsdc(market.totalStake, 0)}`} />
          <Metric label="Liability reserved" value={`${formatUsdc(market.reserved, 0)}`} hint="Worst-case house payout for this market, escrowed now" />
          <Metric label="Capacity left" value={`${formatUsdc(marketCapacity(market, free), 0)}`} hint="Further liability this market can accept" />
          <Metric label="Fee on winnings" value={`${market.feeBps / 100}%`} />
          <Metric label="Stake limits" value={`${formatUsdc(market.minStake, 0)}–${formatUsdc(market.maxStake, 0)}`} />
          <Metric label="Bets" value={String(market.betCount)} />
          <Metric label="Closes" value={formatDateTime(market.closeTime)} />
        </dl>

        {market.oracleResult ? <OracleBox market={market} /> : null}

        <button onClick={() => setRulesOpen((v) => !v)} className="flex w-full items-center justify-between rounded-md border border-line px-3 py-2 text-left text-xs text-muted hover:text-fg">
          <span className="inline-flex items-center gap-1.5">
            <FileCheck2 className="size-3.5" /> Market rules & settlement method
          </span>
          <ChevronDown className={cn("size-4 transition-transform", rulesOpen && "rotate-180")} />
        </button>
        {rulesOpen ? (
          <div className="space-y-2 rounded-md bg-surface-2 p-3 text-xs leading-relaxed text-muted">
            <p>{market.rules}</p>
            <p>
              <span className="text-fg">Settlement:</span> the result is published to the MockOracleAdapter by an account holding REPORTER_ROLE. After the dispute
              window, anyone may call <code className="font-mono text-fg">settleMarket({market.onchainId})</code>; the contract checks the result came from this market&apos;s
              adapter and was reported after betting closed. Winners then claim from escrow.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <dt className="text-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-fg tabular" suppressHydrationWarning>
        {value}
      </dd>
    </div>
  );
}

function OracleBox({ market }: { market: MarketDTO }) {
  const r = market.oracleResult!;
  const winner = r.winningOutcome !== null ? market.outcomes[r.winningOutcome]?.label : null;
  const final = new Date(r.finalAt).getTime() <= Date.now();
  return (
    <div className="rounded-lg border border-info/30 bg-info-dim/40 p-3 text-xs" data-testid="oracle-result">
      <p className="mb-2 flex items-center gap-1.5 font-medium text-info">
        <Gavel className="size-3.5" /> Oracle result {r.status === "CANCELLED" ? "— fixture cancelled" : `— ${winner ?? `outcome ${r.winningOutcome}`}`}
      </p>
      <dl className="grid gap-1 text-muted sm:grid-cols-2">
        <div>Source: <span className="text-fg">{r.source}</span></div>
        <div>Reporter: <span className="font-mono text-fg">{shortAddr(r.reporter)}</span></div>
        <div suppressHydrationWarning>Reported: <span className="text-fg">{new Date(r.reportedAt).toLocaleString()}</span></div>
        <div suppressHydrationWarning>
          Dispute window: {final ? <span className="text-fg">ended — result is final</span> : <>ends in <Countdown to={r.finalAt} className="text-fg" /></>}
        </div>
        <div className="sm:col-span-2">Report tx: <TxLink hash={r.txHash} /></div>
      </dl>
      <p className="mt-2 text-[11px] text-faint">This result is admin-attested by the mock oracle — it is not independently verified. See Transparency.</p>
    </div>
  );
}

function MarketActivity({ marketId }: { marketId: string }) {
  const { data: m } = useMarket(marketId);
  if (!m) return <Skeleton className="h-72 w-full rounded-[var(--radius-card)]" />;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Odds history · {m.title}</CardTitle>
          <Badge tone="warn">Simulated</Badge>
        </CardHeader>
        <CardContent>
          <OddsChart history={m.oddsHistory} labels={m.outcomes.map((o) => o.label)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bet history · {m.title}</CardTitle>
          <span className="text-xs text-muted">{m.betCount} bets</span>
        </CardHeader>
        <CardContent>
          {m.settlement ? (
            <div className="mb-3 rounded-md border border-line bg-surface-2 p-3 text-xs" data-testid="settlement-record">
              <p className="font-medium text-fg">
                {m.settlement.kind === "SETTLED" ? `Settled — ${m.settlement.winningLabel}` : `Cancelled — ${m.settlement.reason}`}
              </p>
              <p className="mt-1 text-muted">
                {m.settlement.kind === "SETTLED"
                  ? `${formatUsdc(m.settlement.winnersPayout)} mUSDC owed to winners · fees ${formatUsdc(m.settlement.fees)} · house ${BigInt(m.settlement.houseDelta) >= 0n ? "+" : ""}${formatUsdc(m.settlement.houseDelta)}`
                  : `${formatUsdc(m.settlement.totalStake)} mUSDC refundable`}{" "}
                · <TxLink hash={m.settlement.txHash} />
              </p>
            </div>
          ) : null}
          {m.recentBets.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted">No bets yet.</p>
          ) : (
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-xs">
                <thead className="text-faint">
                  <tr>
                    <th className="pb-2 text-left font-medium">Bet</th>
                    <th className="pb-2 text-left font-medium">Outcome</th>
                    <th className="pb-2 text-right font-medium">Stake</th>
                    <th className="pb-2 text-right font-medium">Locked</th>
                    <th className="pb-2 pl-4 text-right font-medium">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {m.recentBets.map((b) => (
                    <tr key={b.betId} className="border-t border-line">
                      <td className="py-1.5">
                        <span className="font-mono">#{b.betId}</span> <span className="text-faint">{shortAddr(b.bettor, 3)}</span>
                      </td>
                      <td className="py-1.5">
                        {b.outcomeLabel} <BetStatusBadge status={b.status} refund={b.refund} />
                      </td>
                      <td className="py-1.5 text-right font-mono tabular">{formatUsdc(b.stake)}</td>
                      <td className="py-1.5 text-right font-mono tabular">{formatOdds(b.odds)}</td>
                      <td className="py-1.5 pl-4 text-right" suppressHydrationWarning>
                        <TxLink hash={b.placedTxHash} label={relativeTime(b.placedAt)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OnchainRefs({ event }: { event: EventDTO }) {
  const { data: cfg } = useAppConfig();
  return (
    <Card>
      <CardHeader>
        <CardTitle>On-chain references</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <Ref label="Network" value={cfg ? `${cfg.network} (${cfg.chainId})` : "…"} />
        <Ref label="BettingMarket" value={cfg?.contracts.bettingMarket} mono />
        <Ref label="Oracle adapter (mock)" value={cfg?.contracts.oracleAdapter} mono />
        <Ref label="Event id" value={event.onchainId !== null ? `#${event.onchainId}` : "pending"} mono />
        <div className="flex items-center justify-between gap-3">
          <span className="text-faint">Created in</span>
          <TxLink hash={event.createTxHash} />
        </div>
        {event.markets.map((m) => (
          <Ref key={m.id} label={`Market #${m.onchainId} questionId`} value={m.questionId ? shortHash(m.questionId) : "pending"} mono />
        ))}
      </CardContent>
    </Card>
  );
}

function Ref({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-faint">{label}</span>
      <span className={cn("truncate text-right text-fg", mono && "font-mono")} title={value}>
        {value ? (value.startsWith("0x") && value.length === 42 ? shortAddr(value, 6) : value) : "…"}
      </span>
    </div>
  );
}
