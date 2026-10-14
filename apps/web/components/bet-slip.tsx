"use client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, Loader2, Lock, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { parseEventLogs } from "viem";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { bettingMarketAbi, formatOdds, formatUsdc, mockUsdcAbi, parseUsdc } from "@fairplay/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppConfig, useMarket } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { useBetSlip } from "@/lib/store";
import { cn } from "@/lib/utils";
import { TxLink } from "./tx-link";
import { FaucetButton } from "./wallet-panel";

type Phase =
  | { kind: "idle" }
  | { kind: "approving"; hash?: `0x${string}` }
  | { kind: "placing"; hash?: `0x${string}` }
  | { kind: "done"; hash: `0x${string}`; betId: bigint; lockedOdds: bigint; payout: bigint; block: bigint }
  | { kind: "error"; message: string };

const QUICK = ["10", "25", "100", "250"];

function parseStake(s: string): bigint | null {
  try {
    const v = parseUsdc(s);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function BetSlipPanel({ onClose }: { onClose?: () => void }) {
  const { selection, stake, setStake, clear } = useBetSlip();
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { data: cfg } = useAppConfig();
  const { data: market } = useMarket(selection?.marketId ?? null);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const stakeUnits = parseStake(stake);
  const book = cfg?.contracts.bettingMarket;
  const token = cfg?.contracts.mockUSDC;

  // The authoritative quote: exactly what placeBet would lock in the current block.
  const reads = useReadContracts({
    contracts: [
      { address: book, abi: bettingMarketAbi, functionName: "quote", args: [BigInt(selection?.marketOnchainId ?? 0), BigInt(selection?.outcomeIndex ?? 0), stakeUnits ?? 0n] },
      { address: token, abi: mockUsdcAbi, functionName: "allowance", args: [address!, book!] },
      { address: token, abi: mockUsdcAbi, functionName: "balanceOf", args: [address!] },
      { address: book, abi: bettingMarketAbi, functionName: "getMarket", args: [BigInt(selection?.marketOnchainId ?? 0)] },
    ],
    allowFailure: true,
    query: { enabled: !!selection && !!book && !!token, refetchInterval: 1_500 },
  });
  const quote = reads.data?.[0]?.result as readonly [bigint, bigint, bigint, bigint, boolean] | undefined;
  const allowance = reads.data?.[1]?.result as bigint | undefined;
  const balance = reads.data?.[2]?.result as bigint | undefined;
  const onchainMarket = reads.data?.[3]?.result as { oddsVersion: number; feeBps: number; minStake: bigint; maxStake: bigint } | undefined;

  const executableOdds = quote?.[0];
  const priceMoved = executableOdds !== undefined && selection && executableOdds.toString() !== selection.displayedOdds;
  const pendingUpdate = market?.pendingOdds?.odds[selection?.outcomeIndex ?? 0];

  const problem = useMemo(() => {
    if (!selection) return null;
    if (stakeUnits === null) return "Enter a stake (up to 6 decimals).";
    if (onchainMarket && stakeUnits < onchainMarket.minStake) return `Minimum stake is ${formatUsdc(onchainMarket.minStake)} mUSDC.`;
    if (onchainMarket && stakeUnits > onchainMarket.maxStake) return `Maximum stake is ${formatUsdc(onchainMarket.maxStake, 0)} mUSDC.`;
    if (quote && !quote[4]) return "The contract would reject this bet right now (market closed, or not enough unreserved liquidity for this payout).";
    if (isConnected && balance !== undefined && balance < stakeUnits) return "Not enough mUSDC in this wallet.";
    return null;
  }, [selection, stakeUnits, onchainMarket, quote, isConnected, balance]);

  if (!selection) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Lock className="size-5 text-faint" />
        <p className="text-sm font-medium">Your bet slip is empty</p>
        <p className="text-xs text-muted">Select odds on any open market. Odds lock on-chain at the moment your bet is mined.</p>
      </div>
    );
  }

  const needsApproval = allowance !== undefined && stakeUnits !== null && allowance < stakeUnits;
  const busy = phase.kind === "approving" || phase.kind === "placing";

  const approve = async () => {
    if (!book || !token || stakeUnits === null) return;
    setPhase({ kind: "approving" });
    try {
      const hash = await writeContractAsync({ address: token, abi: mockUsdcAbi, functionName: "approve", args: [book, stakeUnits] });
      setPhase({ kind: "approving", hash });
      const r = await publicClient!.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("approval reverted");
      await reads.refetch();
      setPhase({ kind: "idle" });
    } catch (e) {
      setPhase({ kind: "error", message: describeError(e) });
    }
  };

  const place = async () => {
    if (!book || stakeUnits === null || executableOdds === undefined) return;
    setPhase({ kind: "placing" });
    try {
      // expectedOdds = the on-chain price we just quoted. If it moves before mining, the contract reverts.
      const hash = await writeContractAsync({
        address: book,
        abi: bettingMarketAbi,
        functionName: "placeBet",
        args: [BigInt(selection.marketOnchainId), BigInt(selection.outcomeIndex), stakeUnits, executableOdds],
      });
      setPhase({ kind: "placing", hash });
      const r = await publicClient!.waitForTransactionReceipt({ hash });
      if (r.status !== "success") {
        // Mined but reverted (e.g. the price moved after the wallet estimated gas). Replay the same call
        // against the state the transaction executed on to recover the contract's own error.
        const reason = await publicClient!
          .simulateContract({
            account: address,
            address: book,
            abi: bettingMarketAbi,
            functionName: "placeBet",
            args: [BigInt(selection.marketOnchainId), BigInt(selection.outcomeIndex), stakeUnits, executableOdds],
            blockNumber: r.blockNumber - 1n,
          })
          .then(() => null)
          .catch((e: unknown) => describeError(e));
        throw new Error(`Transaction reverted on-chain (block ${r.blockNumber}). ${reason ?? ""}`.trim());
      }
      const [placed] = parseEventLogs({ abi: bettingMarketAbi, eventName: "BetPlaced", logs: r.logs });
      if (!placed) throw new Error("no BetPlaced event in receipt");
      setPhase({ kind: "done", hash, betId: placed.args.betId, lockedOdds: placed.args.odds, payout: placed.args.potentialPayout, block: r.blockNumber });
      void qc.invalidateQueries({ queryKey: ["bets"] });
      void reads.refetch();
    } catch (e) {
      setPhase({ kind: "error", message: describeError(e) });
      void reads.refetch();
    }
  };

  if (phase.kind === "done") {
    return (
      <div className="p-5" data-testid="bet-confirmed">
        <div className="mb-4 flex items-center gap-2 text-accent-bright">
          <CheckCircle2 className="size-5" />
          <p className="font-semibold">Bet #{phase.betId.toString()} confirmed on-chain</p>
        </div>
        <dl className="space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-sm">
          <Row label="Selection" value={`${selection.outcomeLabel} · ${selection.marketTitle}`} />
          <Row label="Locked odds" value={formatOdds(phase.lockedOdds, 4)} mono strong />
          <Row label="Stake" value={`${formatUsdc(stakeUnits ?? 0n)} mUSDC`} mono />
          <Row label="Payout if it wins" value={`${formatUsdc(phase.payout)} mUSDC`} mono strong />
          <Row label="Block" value={phase.block.toString()} mono />
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">Transaction</dt>
            <dd>
              <TxLink hash={phase.hash} />
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">These values were read from the BetPlaced event in the transaction receipt, not computed by the page.</p>
        <div className="mt-4 flex gap-2">
          <Button asChild variant="secondary" className="flex-1">
            <Link href="/my-bets">View in My Bets</Link>
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setPhase({ kind: "idle" });
              clear();
              onClose?.();
            }}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  const gross = quote?.[1];
  const fee = quote?.[2];
  const net = quote?.[3];
  const feeBps = onchainMarket?.feeBps ?? market?.feeBps ?? 0;

  return (
    <div className="flex flex-col" data-testid="bet-slip">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted">{selection.eventLabel}</p>
          <p className="truncate text-sm font-semibold">{selection.outcomeLabel}</p>
          <p className="truncate text-xs text-muted">{selection.marketTitle}</p>
        </div>
        <button onClick={() => (clear(), onClose?.())} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Remove selection">
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted">Stake (mUSDC)</span>
            {balance !== undefined ? <span className="font-mono text-faint tabular">Balance {formatUsdc(balance)}</span> : null}
          </div>
          <Input inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value.trim())} className="font-mono text-base tabular" data-testid="stake-input" aria-label="Stake" />
          <div className="mt-2 flex gap-1.5">
            {QUICK.map((q) => (
              <button key={q} onClick={() => setStake(q)} className={cn("flex-1 rounded-md border border-line py-1 font-mono text-xs text-muted hover:text-fg", stake === q && "border-accent/60 text-fg")}>
                {q}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-muted">Odds shown when selected</span>
            <span className="font-mono tabular">{formatOdds(selection.displayedOdds, 4)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1 text-muted">
              <ShieldCheck className="size-3.5 text-accent" /> Executable on-chain now
            </span>
            <span className="font-mono text-base font-semibold text-accent-bright tabular" data-testid="executable-odds">
              {executableOdds !== undefined ? formatOdds(executableOdds, 4) : "…"}
            </span>
          </div>
          {onchainMarket ? <p className="mt-1 text-right font-mono text-[10px] text-faint">odds version {onchainMarket.oddsVersion}</p> : null}
        </div>

        {priceMoved ? (
          <Notice tone="warn">The on-chain price moved since you selected this outcome. You will lock the executable price above.</Notice>
        ) : null}
        {pendingUpdate && executableOdds !== undefined && pendingUpdate !== executableOdds.toString() ? (
          <Notice tone="info">
            A simulated odds update to {formatOdds(pendingUpdate)} is pending confirmation. It is not executable yet; if it confirms before your bet, your transaction
            reverts safely and nothing is charged.
          </Notice>
        ) : null}

        <dl className="space-y-1.5 text-sm">
          <Row label="Gross payout if it wins" value={gross !== undefined ? `${formatUsdc(gross)}` : "…"} mono />
          <Row label={`Platform fee (${(feeBps / 100).toFixed(feeBps % 100 ? 2 : 0)}% of winnings)`} value={fee !== undefined ? `− ${formatUsdc(fee)}` : "…"} mono />
          <Row label="Estimated net payout" value={net !== undefined ? `${formatUsdc(net)} mUSDC` : "…"} mono strong testId="net-payout" />
          <Row label="Maximum loss" value={stakeUnits !== null ? `${formatUsdc(stakeUnits)} mUSDC` : "—"} mono />
        </dl>

        {problem ? <Notice tone="warn">{problem}</Notice> : null}
        {phase.kind === "error" ? (
          <Notice tone="danger" testId="bet-error">
            {phase.message}
          </Notice>
        ) : null}

        {!isConnected ? (
          <Button className="w-full" size="lg" onClick={openConnectModal}>
            Connect wallet to bet
          </Button>
        ) : balance !== undefined && stakeUnits !== null && balance < stakeUnits ? (
          <FaucetButton />
        ) : needsApproval ? (
          <Button className="w-full" size="lg" onClick={approve} disabled={busy || !!problem} data-testid="approve-button">
            {phase.kind === "approving" ? <Loader2 className="animate-spin" /> : null}
            {phase.kind === "approving" ? (phase.hash ? "Confirming approval…" : "Approve in wallet…") : `Approve ${stake} mUSDC`}
          </Button>
        ) : (
          <Button className="w-full" size="lg" onClick={place} disabled={busy || !!problem || executableOdds === undefined} data-testid="place-bet-button">
            {phase.kind === "placing" ? <Loader2 className="animate-spin" /> : <Lock />}
            {phase.kind === "placing" ? (phase.hash ? "Waiting for block…" : "Confirm in wallet…") : `Place bet at ${executableOdds !== undefined ? formatOdds(executableOdds) : "…"}`}
          </Button>
        )}
        {(phase.kind === "placing" || phase.kind === "approving") && phase.hash ? (
          <p className="text-center text-xs text-muted">
            Submitted <TxLink hash={phase.hash} /> — pending until mined.
          </p>
        ) : null}
        <p className="text-[11px] leading-relaxed text-faint">
          Odds are locked into your bet when it is mined; later odds moves never change it. Payouts are paid by the contract from escrow, never by this page.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, mono, strong, testId }: { label: string; value: string; mono?: boolean; strong?: boolean; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cn(mono && "font-mono tabular", strong && "font-semibold text-fg")} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function Notice({ tone, children, testId }: { tone: "warn" | "info" | "danger"; children: React.ReactNode; testId?: string }) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex gap-2 rounded-lg border p-2.5 text-xs leading-relaxed",
        tone === "warn" && "border-warn/30 bg-warn-dim/60 text-warn",
        tone === "info" && "border-info/30 bg-info-dim/60 text-info",
        tone === "danger" && "border-danger/30 bg-danger-dim/60 text-danger",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** Global slide-over used on every page except event pages on large screens (which render the slip inline). */
export function BetSlipDock() {
  const { selection, open, setOpen } = useBetSlip();
  const pathname = usePathname();
  const inlineOnDesktop = pathname.startsWith("/events/");
  return (
    <>
      <AnimatePresence>
        {selection && open ? (
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 36 }}
            className={cn(
              "fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-y-auto border-l border-line bg-surface shadow-2xl",
              inlineOnDesktop && "lg:hidden",
            )}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <p className="text-sm font-semibold">Bet slip</p>
              <button className="text-xs text-muted hover:text-fg" onClick={() => setOpen(false)}>
                Hide
              </button>
            </div>
            <BetSlipPanel onClose={() => setOpen(false)} />
          </motion.aside>
        ) : null}
      </AnimatePresence>
      {selection && !open ? (
        <button
          onClick={() => setOpen(true)}
          className={cn("fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-semibold text-[#04130d] shadow-xl", inlineOnDesktop && "lg:hidden")}
        >
          Bet slip · {selection.outcomeLabel}
        </button>
      ) : null}
    </>
  );
}
