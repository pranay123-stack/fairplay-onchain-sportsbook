"use client";
import { AlertTriangle, CheckCircle2, Copy, Database, Scale, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { formatUsdc } from "@fairplay/shared";
import { TxLink } from "@/components/tx-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppConfig, useChainEvents, useSettlements, useStats } from "@/lib/api";
import { relativeTime, shortAddr } from "@/lib/utils";

export default function TransparencyPage() {
  const { data: s } = useStats();
  const { data: cfg } = useAppConfig();
  const { data: settlements } = useSettlements();
  const { data: logs } = useChainEvents();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Transparency</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every figure on this page is read live from the contracts or from the indexed contract events. What the system can prove — and what it cannot — is
          spelled out at the bottom.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Escrow & solvency</CardTitle>
              <CardDescription>BettingMarket.solvency() and its accounting buckets, read now.</CardDescription>
            </div>
            {s ? (
              BigInt(s.onchain.escrowHeld) >= BigInt(s.onchain.escrowRequired) && BigInt(s.onchain.houseBalance) >= BigInt(s.onchain.totalReserved) ? (
                <Badge tone="accent" data-testid="solvency-ok">
                  <ShieldCheck className="size-3" /> Fully collateralised
                </Badge>
              ) : (
                <Badge tone="danger">
                  <ShieldAlert className="size-3" /> Under-collateralised
                </Badge>
              )
            ) : null}
          </CardHeader>
          <CardContent>
            {!s ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Big label="Tokens held by the contract" value={s.onchain.escrowHeld} />
                  <Big label="Tokens the contract owes (sum of buckets)" value={s.onchain.escrowRequired} />
                </div>
                <EscrowBar s={s.onchain} />
                <div className="mt-5 grid gap-3 text-xs sm:grid-cols-3">
                  <Small label="House liability reserved" value={s.onchain.totalReserved} hint="Σ worst-case payouts over open markets" />
                  <Small label="Free house liquidity" value={s.onchain.freeLiquidity} hint="Withdrawable; never backs an open bet" />
                  <Small label="Fee rate" raw={`${s.onchain.feeBps / 100}% of winnings`} />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contracts</CardTitle>
            <Badge>{cfg ? `chain ${cfg.chainId}` : "…"}</Badge>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <p className="text-muted">Network: <span className="text-fg">{cfg?.network ?? "…"}</span></p>
            {cfg
              ? (
                  [
                    ["BettingMarket", cfg.contracts.bettingMarket],
                    ["MockUSDC (testnet)", cfg.contracts.mockUSDC],
                    ["MockOracleAdapter", cfg.contracts.oracleAdapter],
                    ["Operator service", cfg.services.operator],
                    ["Oracle reporter (mock)", cfg.services.reporter],
                  ] as const
                ).map(([label, addr]) => <AddressRow key={label} label={label} address={addr} />)
              : null}
            <p className="text-faint">Deployed at block {cfg?.deployBlock ?? "…"} · oracle dispute window {cfg?.oracleFinalitySeconds ?? "…"}s</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Bets on-chain" value={s?.onchain.betCount} />
        <StatCard label="Markets on-chain" value={s?.onchain.marketCount} />
        <StatCard label="Resolved markets" value={s ? s.totals.settledMarkets + s.totals.cancelledMarkets : undefined} sub={s ? `${s.totals.settledMarkets} settled · ${s.totals.cancelledMarkets} cancelled` : ""} />
        <StatCard label="Total volume staked" value={s ? formatUsdc(s.totals.volume, 0) : undefined} sub="mUSDC (testnet)" />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-muted" /> Indexer & reconciliation
            </CardTitle>
            <CardDescription>The database is a read model. It is periodically compared field-by-field with contract state at the indexed block.</CardDescription>
          </div>
          {s?.reconciliation.checkedAt ? (
            s.reconciliation.ok ? (
              <Badge tone="accent" data-testid="reconciled">
                <CheckCircle2 className="size-3" /> Matches chain
              </Badge>
            ) : (
              <Badge tone="danger">
                <AlertTriangle className="size-3" /> {s.reconciliation.mismatches.length} mismatches
              </Badge>
            )
          ) : (
            <Badge>Not yet checked</Badge>
          )}
        </CardHeader>
        <CardContent className="grid gap-3 text-xs sm:grid-cols-5">
          <KV k="Chain head" v={s?.indexer.chainHead} />
          <KV k="Indexed to block" v={s?.indexer.lastIndexedBlock} />
          <KV k="Confirmation depth" v={s?.indexer.confirmations} />
          <KV k="Reorgs handled" v={s?.indexer.reorgsHandled} />
          <KV k="Last check" v={s?.reconciliation.checkedAt ? `${relativeTime(s.reconciliation.checkedAt)} · ${s.reconciliation.checkedMarkets} markets, ${s.reconciliation.checkedBets} bets` : "—"} />
          {s && !s.reconciliation.ok ? (
            <ul className="col-span-full list-disc pl-5 font-mono text-danger">
              {s.reconciliation.mismatches.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settlement records</CardTitle>
          <CardDescription>From MarketSettled / MarketCancelled events.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {!settlements?.length ? (
            <p className="py-6 text-center text-xs text-muted">No markets resolved yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-xs" data-testid="settlements-table">
              <thead className="text-faint">
                <tr className="text-left">
                  <th className="pb-2 font-medium">Market</th>
                  <th className="pb-2 font-medium">Outcome</th>
                  <th className="pb-2 text-right font-medium">Staked</th>
                  <th className="pb-2 text-right font-medium">To bettors</th>
                  <th className="pb-2 text-right font-medium">Fees</th>
                  <th className="pb-2 text-right font-medium">House Δ</th>
                  <th className="pb-2 pl-6 font-medium">Result source</th>
                  <th className="pb-2 text-right font-medium">Tx</th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((r) => (
                  <tr key={r.marketOnchainId} className="border-t border-line align-top">
                    <td className="py-2">
                      <p className="font-medium text-fg">{r.eventLabel}</p>
                      <p className="text-faint">#{r.marketOnchainId} · {r.marketTitle}</p>
                    </td>
                    <td className="py-2">{r.kind === "SETTLED" ? <Badge tone="info">{r.winningLabel}</Badge> : <Badge tone="danger">Cancelled</Badge>}</td>
                    <td className="py-2 text-right font-mono tabular">{formatUsdc(r.totalStake)}</td>
                    <td className="py-2 text-right font-mono tabular">{formatUsdc(r.kind === "SETTLED" ? r.winnersPayout : r.totalStake)}</td>
                    <td className="py-2 text-right font-mono tabular">{formatUsdc(r.fees)}</td>
                    <td className="py-2 text-right font-mono tabular">{formatUsdc(r.houseDelta)}</td>
                    <td className="py-2 pl-6 text-muted">
                      {r.kind === "SETTLED" ? (
                        <>
                          mock oracle {shortAddr(r.oracleReporter)}
                          <br />
                          <span className="text-faint">{r.resultReportedAt ? new Date(r.resultReportedAt).toLocaleString() : ""}</span>
                        </>
                      ) : (
                        r.reason
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <TxLink hash={r.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent contract events</CardTitle>
            <CardDescription>Indexed, decoded logs</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[420px] space-y-1 overflow-y-auto">
            {(logs ?? []).map((l) => (
              <div key={`${l.txHash}-${l.logIndex}`} className="grid grid-cols-[1fr_70px_auto] items-center gap-3 border-t border-line py-1.5 text-xs first:border-t-0">
                <span className="min-w-0 truncate">
                  <span className="font-mono text-accent-bright">{l.eventName}</span> <span className="text-faint">{l.contract === "MockOracleAdapter" ? "· oracle" : ""}</span>
                </span>
                <span className="text-right font-mono text-faint">#{l.blockNumber}</span>
                <TxLink hash={l.txHash} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Verify it yourself</CardTitle>
            <CardDescription>Nothing on this page needs to be trusted — query the chain directly.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <Cmd title="Escrow held vs owed" cmd={`cast call ${cfg?.contracts.bettingMarket ?? "<BettingMarket>"} "solvency()(uint256,uint256)" --rpc-url ${cfg?.rpcUrl ?? "<rpc>"}`} />
            <Cmd title="A bet's locked odds and payout" cmd={`cast call ${cfg?.contracts.bettingMarket ?? "<BettingMarket>"} "getBet(uint256)((uint256,address,uint256,uint256,uint256,uint256,uint256,bool))" 1 --rpc-url ${cfg?.rpcUrl ?? "<rpc>"}`} />
            <Cmd title="Who may report results" cmd={`cast call ${cfg?.contracts.oracleAdapter ?? "<Oracle>"} "hasRole(bytes32,address)(bool)" $(cast keccak REPORTER_ROLE) ${cfg?.services.reporter ?? "<addr>"} --rpc-url ${cfg?.rpcUrl ?? "<rpc>"}`} />
            <p className="text-muted">
              Source verification: on Sepolia, run <code className="font-mono text-fg">forge verify-contract</code> (see docs/SMART_CONTRACTS.md) so the deployed
              bytecode can be matched to this repository. The local Anvil chain has no public explorer; the in-app transaction pages read the node directly.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-warn/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Scale className="size-4 text-warn" /> Trust assumptions — read this
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 text-sm leading-relaxed text-muted md:grid-cols-3">
          <div>
            <p className="mb-1 font-medium text-fg">What the contract guarantees</p>
            <p>
              Transparent on-chain settlement: stakes are escrowed, odds are locked per bet, every accepted bet is fully collateralised by reserved house
              liquidity, payouts follow fixed integer maths, nobody can claim twice, and reserved funds cannot be withdrawn. These properties are enforced by code
              and covered by fuzz and invariant tests — <em>not</em> by an external audit, which has not been performed.
            </p>
          </div>
          <div>
            <p className="mb-1 font-medium text-fg">What it does NOT guarantee</p>
            <p>
              That a reported sporting result is true. In this MVP, results come from a <span className="text-fg">mock oracle controlled by the operator</span>. The
              contract verifies <em>who</em> reported (REPORTER_ROLE), <em>when</em> (after betting closed), and enforces a dispute window — but an operator who
              controls the reporter key could report a false result. Processing a result on-chain does not make it fair.
            </p>
          </div>
          <div>
            <p className="mb-1 font-medium text-fg">Randomness vs. real-world results</p>
            <p>
              &ldquo;Provably fair&rdquo; in the cryptographic sense applies to randomness (e.g. VRF-backed games), which can be verified mathematically. Sports outcomes
              cannot: they need trustworthy data. The OracleAdapter interface is designed to be swapped for an optimistic-dispute oracle or independent data
              providers — see docs/PRODUCTION_ROADMAP.md. No such integration exists in this demo.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EscrowBar({ s }: { s: { houseBalance: string; openStake: string; outstandingClaims: string; accruedFees: string; escrowRequired: string } }) {
  const total = Number(BigInt(s.escrowRequired)) || 1;
  // Four buckets of one whole: a single 100% bar with 2px surface gaps, legend + values in text tokens.
  const parts = [
    { k: "House liquidity", v: s.houseBalance, c: "#3987e5" },
    { k: "Open stakes", v: s.openStake, c: "#d95926" },
    { k: "Owed to bettors", v: s.outstandingClaims, c: "#199e70" },
    { k: "Accrued fees", v: s.accruedFees, c: "#c98500" },
  ];
  return (
    <div className="mt-5">
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="Escrow composition">
        {parts.map((p) => {
          const pct = (Number(BigInt(p.v)) / total) * 100;
          return pct > 0 ? <div key={p.k} style={{ width: `${Math.max(pct, 0.6)}%`, background: p.c }} title={`${p.k}: ${formatUsdc(p.v)} mUSDC`} /> : null;
        })}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {parts.map((p) => (
          <div key={p.k}>
            <dt className="flex items-center gap-1.5 text-muted">
              <span className="size-2 rounded-sm" style={{ background: p.c }} /> {p.k}
            </dt>
            <dd className="mt-0.5 font-mono text-fg tabular">{formatUsdc(p.v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular">
        {formatUsdc(value)} <span className="text-sm font-normal text-muted">mUSDC</span>
      </p>
    </div>
  );
}

function Small({ label, value, raw, hint }: { label: string; value?: string; raw?: string; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-faint">{label}</p>
      <p className="mt-0.5 font-mono text-fg tabular">{raw ?? `${formatUsdc(value ?? "0")} mUSDC`}</p>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value?: string | number; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] uppercase tracking-wider text-faint">{label}</p>
      <p className="mt-1.5 font-mono text-xl font-semibold tabular">{value ?? "…"}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </Card>
  );
}

function KV({ k, v }: { k: string; v?: string | number }) {
  return (
    <div>
      <p className="text-faint">{k}</p>
      <p className="mt-0.5 font-mono text-fg">{v ?? "…"}</p>
    </div>
  );
}

function AddressRow({ label, address }: { label: string; address: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <button
        className="inline-flex items-center gap-1.5 font-mono text-fg hover:text-accent-bright"
        onClick={() => {
          void navigator.clipboard?.writeText(address);
          toast.success("Address copied");
        }}
        title={address}
      >
        {shortAddr(address, 6)} <Copy className="size-3" />
      </button>
    </div>
  );
}

function Cmd({ title, cmd }: { title: string; cmd: string }) {
  return (
    <div>
      <p className="mb-1 text-muted">{title}</p>
      <pre className="overflow-x-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px] text-fg">{cmd}</pre>
    </div>
  );
}
