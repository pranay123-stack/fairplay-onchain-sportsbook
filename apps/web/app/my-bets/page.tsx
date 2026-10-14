"use client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldCheck, Wallet } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { BET_STATUS, bettingMarketAbi, formatOdds, formatUsdc, type BetDTO, type BetStatus } from "@fairplay/shared";
import { BetStatusBadge } from "@/components/status";
import { TxLink } from "@/components/tx-link";
import { FaucetButton } from "@/components/wallet-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppConfig, useBets } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { formatDateTime } from "@/lib/utils";

type Filter = "all" | "open" | "won" | "lost" | "refunded";
const FILTERS: Array<{ id: Filter; label: string; match: (b: BetDTO) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "open", label: "Open", match: (b) => b.status === "OPEN" },
  { id: "won", label: "Won", match: (b) => b.status === "WON" || (b.status === "CLAIMED" && b.refund === false) },
  { id: "lost", label: "Lost", match: (b) => b.status === "LOST" },
  { id: "refunded", label: "Refunded", match: (b) => b.status === "REFUNDABLE" || (b.status === "CLAIMED" && b.refund === true) },
];

export default function MyBetsPage() {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { data: cfg } = useAppConfig();
  const { data: bets, isLoading } = useBets(address);
  const [filter, setFilter] = useState<Filter>("all");
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const qc = useQueryClient();
  const [claiming, setClaiming] = useState<string | null>(null);

  // Authoritative status for every bet, straight from the contract (the list itself comes from the indexer).
  const onchain = useReadContracts({
    contracts: (bets ?? []).map((b) => ({ address: cfg?.contracts.bettingMarket, abi: bettingMarketAbi, functionName: "betStatus" as const, args: [BigInt(b.betId)] })),
    query: { enabled: !!cfg && !!bets?.length, refetchInterval: 4_000 },
  });
  const chainStatus = (i: number): BetStatus | undefined => {
    const r = onchain.data?.[i]?.result;
    return r === undefined ? undefined : BET_STATUS[Number(r)];
  };

  const summary = useMemo(() => {
    let staked = 0n;
    let claimable = 0n;
    let open = 0n;
    for (const b of bets ?? []) {
      staked += BigInt(b.stake);
      if (b.status === "WON") claimable += BigInt(b.potentialPayout);
      if (b.status === "REFUNDABLE") claimable += BigInt(b.stake);
      if (b.status === "OPEN") open += BigInt(b.potentialPayout);
    }
    return { staked, claimable, open };
  }, [bets]);

  const claim = async (ids: number[]) => {
    if (!cfg) return;
    const key = ids.join(",");
    setClaiming(key);
    try {
      const hash =
        ids.length === 1
          ? await writeContractAsync({ address: cfg.contracts.bettingMarket, abi: bettingMarketAbi, functionName: "claim", args: [BigInt(ids[0]!)] })
          : await writeContractAsync({ address: cfg.contracts.bettingMarket, abi: bettingMarketAbi, functionName: "claimMany", args: [ids.map(BigInt)] });
      toast.message("Claim submitted", { description: "Waiting for the block…" });
      const r = await publicClient!.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("claim reverted");
      toast.success("Claim confirmed on-chain", { description: `Block ${r.blockNumber} · ${hash.slice(0, 18)}…` });
      await onchain.refetch();
      void qc.invalidateQueries({ queryKey: ["bets"] });
    } catch (e) {
      toast.error("Claim failed", { description: describeError(e) });
    } finally {
      setClaiming(null);
    }
  };

  if (!isConnected) {
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <Wallet className="mx-auto mb-3 size-6 text-muted" />
        <h1 className="text-lg font-semibold">Connect a wallet to see your bets</h1>
        <p className="mt-1 text-sm text-muted">Bets are read from the indexer and verified against the contract.</p>
        <Button className="mt-5" onClick={openConnectModal}>Connect wallet</Button>
      </Card>
    );
  }

  const claimableIds = (bets ?? []).filter((b, i) => (chainStatus(i) ?? b.status) === "WON" || (chainStatus(i) ?? b.status) === "REFUNDABLE").map((b) => b.betId);
  const shown = (bets ?? []).map((b, i) => ({ b, i })).filter(({ b }) => FILTERS.find((f) => f.id === filter)!.match(b));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Bets</h1>
          <p className="mt-1 font-mono text-xs text-muted">{address}</p>
        </div>
        <div className="flex gap-2">
          <FaucetButton compact />
          {claimableIds.length > 1 ? (
            <Button size="sm" onClick={() => claim(claimableIds)} disabled={!!claiming} data-testid="claim-all">
              {claiming === claimableIds.join(",") ? <Loader2 className="animate-spin" /> : null}
              Claim all ({claimableIds.length})
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line lg:grid-cols-4">
        <Tile label="Total testnet stake" value={formatUsdc(summary.staked)} />
        <Tile label="Claimable now" value={formatUsdc(summary.claimable)} accent testId="claimable-total" />
        <Tile label="Open bets' potential payout" value={formatUsdc(summary.open)} />
        <Tile label="Bets" value={String(bets?.length ?? 0)} unit="" />
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.id} value={f.id}>
              {f.label}
              <span className="font-mono text-faint">{(bets ?? []).filter(f.match).length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-[var(--radius-card)]" />
      ) : shown.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted">
          {bets?.length ? "No bets in this view." : (
            <>
              No bets yet. <Link href="/" className="text-accent-bright hover:underline">Explore markets</Link> to place one.
            </>
          )}
        </Card>
      ) : (
        <div className="space-y-2">
          {shown.map(({ b, i }) => {
            const verified = chainStatus(i);
            const status = verified ?? b.status;
            const lagging = verified !== undefined && verified !== b.status;
            return (
              <Card key={b.betId} className="p-4" data-testid="bet-row">
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-faint">#{b.betId}</span>
                      <BetStatusBadge status={status} refund={b.refund} />
                      {verified !== undefined ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-accent" title="Status read from BettingMarket.betStatus() just now">
                          <ShieldCheck className="size-3" /> verified on-chain
                        </span>
                      ) : null}
                      {lagging ? <span className="text-[10px] text-warn">indexer catching up</span> : null}
                    </div>
                    <p className="mt-1 truncate text-sm font-medium">
                      {b.outcomeLabel ?? `Outcome ${b.outcomeIndex}`} <span className="text-muted">· {b.marketTitle}</span>
                    </p>
                    <p className="truncate text-xs text-muted">
                      {b.eventId ? (
                        <Link href={`/events/${b.eventId}`} className="hover:text-fg hover:underline">
                          {b.eventLabel}
                        </Link>
                      ) : (
                        b.eventLabel
                      )}{" "}
                      · <span suppressHydrationWarning>{formatDateTime(b.placedAt)}</span>
                    </p>
                  </div>
                  <dl className="grid grid-cols-3 gap-4 text-xs md:w-[360px]">
                    <div>
                      <dt className="text-faint">Stake</dt>
                      <dd className="font-mono tabular">{formatUsdc(b.stake)}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">Locked odds</dt>
                      <dd className="font-mono tabular">{formatOdds(b.odds)}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">{b.claimed ? "Paid" : status === "REFUNDABLE" ? "Refund" : "Payout"}</dt>
                      <dd className="font-mono tabular">{formatUsdc(b.claimed ? (b.payoutAmount ?? "0") : status === "REFUNDABLE" ? b.stake : b.potentialPayout)}</dd>
                    </div>
                  </dl>
                  <div className="flex items-center justify-between gap-3 md:w-44 md:flex-col md:items-end">
                    <div className="space-y-0.5 text-right">
                      <div className="text-[10px] text-faint">placed <TxLink hash={b.placedTxHash} /></div>
                      {b.claimTxHash ? <div className="text-[10px] text-faint">claimed <TxLink hash={b.claimTxHash} /></div> : null}
                    </div>
                    {status === "WON" || status === "REFUNDABLE" ? (
                      <Button size="sm" onClick={() => claim([b.betId])} disabled={!!claiming} data-testid={`claim-${b.betId}`}>
                        {claiming === String(b.betId) ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                        {status === "WON" ? "Claim payout" : "Claim refund"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, accent, testId, unit = "mUSDC" }: { label: string; value: string; accent?: boolean; testId?: string; unit?: string }) {
  return (
    <div className="bg-surface p-4">
      <p className="text-[11px] uppercase tracking-wider text-faint">{label}</p>
      <p className={`mt-1.5 font-mono text-lg font-semibold tabular ${accent ? "text-accent-bright" : ""}`} data-testid={testId}>
        {value} {unit ? <span className="text-xs font-normal text-muted">{unit}</span> : null}
      </p>
    </div>
  );
}
