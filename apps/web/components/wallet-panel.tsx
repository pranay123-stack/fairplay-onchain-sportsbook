"use client";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { Droplets, Loader2, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { formatUsdc, mockUsdcAbi } from "@fairplay/shared";
import { Button } from "@/components/ui/button";
import { useAppConfig } from "@/lib/api";
import { describeError } from "@/lib/errors";

export function useUsdcBalance() {
  const { address } = useAccount();
  const { data: cfg } = useAppConfig();
  const token = cfg?.contracts.mockUSDC;
  const q = useReadContracts({
    contracts: [
      { address: token, abi: mockUsdcAbi, functionName: "balanceOf", args: [address!] },
      { address: token, abi: mockUsdcAbi, functionName: "faucetAvailableIn", args: [address!] },
      { address: token, abi: mockUsdcAbi, functionName: "faucetAmount" },
    ],
    query: { enabled: !!address && !!token, refetchInterval: 4_000 },
  });
  return {
    balance: q.data?.[0]?.result as bigint | undefined,
    faucetIn: q.data?.[1]?.result as bigint | undefined,
    faucetAmount: q.data?.[2]?.result as bigint | undefined,
    refetch: q.refetch,
  };
}

export function FaucetButton({ compact = false }: { compact?: boolean }) {
  const { address } = useAccount();
  const { data: cfg } = useAppConfig();
  const publicClient = usePublicClient();
  const qc = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const { faucetIn, faucetAmount, refetch } = useUsdcBalance();
  const [busy, setBusy] = useState(false);
  if (!address || !cfg) return null;
  const cooling = faucetIn !== undefined && faucetIn > 0n;

  const drip = async () => {
    setBusy(true);
    try {
      const hash = await writeContractAsync({ address: cfg.contracts.mockUSDC, abi: mockUsdcAbi, functionName: "faucet" });
      toast.message("Faucet transaction sent", { description: `${hash.slice(0, 18)}… waiting for confirmation` });
      const r = await publicClient!.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("faucet transaction reverted");
      toast.success(`Received ${formatUsdc(faucetAmount ?? 0n, 0)} mUSDC (testnet)`, { description: `Confirmed in block ${r.blockNumber}` });
      await refetch();
      void qc.invalidateQueries();
    } catch (e) {
      toast.error("Faucet failed", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size={compact ? "sm" : "md"}
      onClick={drip}
      disabled={busy || cooling}
      title={cooling ? `Faucet available again in ${Math.ceil(Number(faucetIn) / 60)} min` : "Mint free testnet mUSDC"}
      data-testid="faucet-button"
    >
      {busy ? <Loader2 className="animate-spin" /> : <Droplets />}
      {cooling ? `Faucet in ${Math.ceil(Number(faucetIn) / 60)}m` : "Get test mUSDC"}
    </Button>
  );
}

export function WalletButton() {
  const { balance } = useUsdcBalance();
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const ready = mounted;
        if (!ready) return <div className="h-10 w-36" aria-hidden />;
        if (!account || !chain) {
          return (
            <Button onClick={openConnectModal} data-testid="connect-wallet">
              <Wallet /> Connect wallet
            </Button>
          );
        }
        if (chain.unsupported) {
          return (
            <Button variant="danger" onClick={openChainModal}>
              Wrong network
            </Button>
          );
        }
        return (
          <button
            onClick={openAccountModal}
            className="flex h-10 items-center gap-3 rounded-lg border border-line bg-surface-2 pl-3 pr-2 text-sm transition-colors hover:border-line-strong"
            data-testid="account-button"
          >
            <span className="hidden font-mono text-xs tabular text-muted sm:inline" data-testid="usdc-balance">
              {balance !== undefined ? `${formatUsdc(balance)} mUSDC` : "…"}
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 font-mono text-xs">
              <span className="size-1.5 rounded-full bg-accent" />
              {account.displayName}
            </span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
