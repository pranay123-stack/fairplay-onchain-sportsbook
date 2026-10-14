"use client";
import { motion } from "framer-motion";
import { Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { formatUsdc, type EventDTO } from "@fairplay/shared";
import { EventCard, SportIcon } from "@/components/event-card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEvents, useStats } from "@/lib/api";

const SPORTS = [
  { id: "", label: "All sports" },
  { id: "football", label: "Football" },
  { id: "basketball", label: "Basketball" },
  { id: "esports", label: "Esports" },
] as const;

const STATUS = [
  { id: "upcoming", label: "Upcoming" },
  { id: "settled", label: "Settled" },
  { id: "all", label: "All" },
] as const;

export default function SportsbookPage() {
  const [sport, setSport] = useState("");
  const [status, setStatus] = useState("upcoming");
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const { data: events, isLoading, error } = useEvents({ sport: sport || undefined, q: query || undefined, status });
  const { data: stats } = useStats();

  const featured = useMemo(() => (events ?? []).filter((e) => e.featured && status === "upcoming" && !sport && !query), [events, status, sport, query]);
  const rest = useMemo(() => (events ?? []).filter((e) => !featured.includes(e)), [events, featured]);

  return (
    <div className="space-y-10">
      <section className="relative -mx-4 overflow-hidden px-4 pb-4 pt-8 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative grid gap-8 lg:grid-cols-[1.25fr_1fr] lg:items-end">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-dim/60 px-3 py-1 text-xs text-accent-bright">
              <ShieldCheck className="size-3.5" /> Every bet, odds lock and payout is an on-chain record
            </p>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
              Bet Transparently.
              <br />
              <span className="text-accent-bright">Verify Everything.</span>
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted">
              On-chain sports markets with transparent rules, verifiable settlement, and testnet payouts.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 text-sm">
              <a href="#markets" className="rounded-lg bg-accent px-4 py-2.5 font-semibold text-[#04130d] hover:bg-accent-bright">
                Explore markets
              </a>
              <Link href="/transparency" className="rounded-lg border border-line px-4 py-2.5 text-fg hover:border-line-strong">
                How settlement works
              </Link>
            </div>
          </motion.div>
          <motion.dl
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 }}
            className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line"
            data-testid="hero-stats"
          >
            <Stat label="Escrowed in contract" value={stats ? `${formatUsdc(stats.onchain.escrowHeld, 0)}` : null} unit="mUSDC" />
            <Stat label="Free house liquidity" value={stats ? `${formatUsdc(stats.onchain.freeLiquidity, 0)}` : null} unit="mUSDC" />
            <Stat label="Bets on-chain" value={stats ? String(stats.onchain.betCount) : null} />
            <Stat
              label="Read model vs chain"
              value={stats ? (stats.reconciliation.checkedAt ? (stats.reconciliation.ok ? "Reconciled" : "Mismatch") : "Checking…") : null}
              tone={stats?.reconciliation.ok === false ? "danger" : "accent"}
            />
          </motion.dl>
        </div>
      </section>

      <section id="markets" className="scroll-mt-28 space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs value={sport} onValueChange={setSport}>
            <TabsList>
              {SPORTS.map((s) => (
                <TabsTrigger key={s.id} value={s.id} data-testid={`sport-${s.id || "all"}`}>
                  {s.id ? <SportIcon sport={s.id} /> : null}
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search teams or leagues" className="pl-9" aria-label="Search events" />
            </div>
            <Tabs value={status} onValueChange={setStatus}>
              <TabsList>
                {STATUS.map((s) => (
                  <TabsTrigger key={s.id} value={s.id}>
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
        </div>

        {error ? (
          <div className="rounded-[var(--radius-card)] border border-danger/30 bg-danger-dim/40 p-6 text-sm text-danger">
            Could not reach the FairPlay API. Is it running? ({(error as Error).message})
          </div>
        ) : isLoading ? (
          <Grid>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-56 rounded-[var(--radius-card)]" />
            ))}
          </Grid>
        ) : (
          <>
            {featured.length > 0 ? (
              <EventSection title="Featured" subtitle="Highlighted demo fixtures — odds on these markets move via the simulated odds engine." events={featured} free={stats?.onchain.freeLiquidity} />
            ) : null}
            <EventSection
              title={status === "settled" ? "Settled & cancelled" : featured.length ? "All upcoming" : "Events"}
              events={rest}
              free={stats?.onchain.freeLiquidity}
              empty={query ? `No events match “${query}”.` : "No events in this view."}
            />
          </>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, unit, tone }: { label: string; value: string | null; unit?: string; tone?: "accent" | "danger" }) {
  return (
    <div className="bg-surface p-4">
      <dt className="text-[11px] uppercase tracking-wider text-faint">{label}</dt>
      <dd className={`mt-1.5 font-mono text-lg font-semibold tabular ${tone === "danger" ? "text-danger" : tone === "accent" ? "text-accent-bright" : "text-fg"}`}>
        {value ?? <Skeleton className="h-6 w-24" />}
        {value && unit ? <span className="ml-1 text-xs font-normal text-muted">{unit}</span> : null}
      </dd>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function EventSection({ title, subtitle, events, free, empty }: { title: string; subtitle?: string; events: EventDTO[]; free?: string; empty?: string }) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="text-xs text-muted">{subtitle}</p> : null}
      </div>
      {events.length === 0 ? (
        <p className="rounded-[var(--radius-card)] border border-dashed border-line p-8 text-center text-sm text-muted">{empty}</p>
      ) : (
        <Grid>
          {events.map((e, i) => (
            <motion.div key={e.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.03, 0.3) }}>
              <EventCard event={e} freeLiquidity={free} />
            </motion.div>
          ))}
        </Grid>
      )}
    </div>
  );
}
