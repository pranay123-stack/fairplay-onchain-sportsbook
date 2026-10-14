"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { toast } from "sonner";
import { useAccount } from "wagmi";
import { formatUsdc, WS } from "@fairplay/shared";
import { API_URL } from "./env";

/** Bridges Socket.IO notifications into TanStack Query invalidations + toasts. Data always refetches from the API. */
export function useRealtime() {
  const qc = useQueryClient();
  const { address } = useAccount();
  const [connected, setConnected] = useState(false);
  const [head, setHead] = useState<{ head: number; indexed: number } | null>(null);

  useEffect(() => {
    const socket = io(API_URL, { transports: ["websocket"], reconnectionDelay: 1500 });
    const refreshMarkets = () => {
      void qc.invalidateQueries({ queryKey: ["events"] });
      void qc.invalidateQueries({ queryKey: ["event"] });
      void qc.invalidateQueries({ queryKey: ["market"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    };
    socket.on("connect", () => {
      setConnected(true);
      if (address) socket.emit("subscribe:wallet", address);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on(WS.chainHead, (p: { head: number; indexed: number }) => setHead(p));
    socket.on(WS.eventCreated, refreshMarkets);
    socket.on(WS.marketCreated, refreshMarkets);
    socket.on(WS.marketStatus, refreshMarkets);
    socket.on(WS.oddsPending, refreshMarkets);
    socket.on(WS.oddsUpdated, refreshMarkets);
    socket.on(WS.resultReported, (p: { status: string }) => {
      refreshMarkets();
      toast.message("Oracle result published", { description: p.status === "CANCELLED" ? "Fixture reported cancelled — refunds after the dispute window." : "Settlement follows after the dispute window." });
    });
    socket.on(WS.marketSettled, () => {
      refreshMarkets();
      void qc.invalidateQueries({ queryKey: ["bets"] });
      void qc.invalidateQueries({ queryKey: ["settlements"] });
      toast.success("Market settled on-chain");
    });
    socket.on(WS.marketCancelled, () => {
      refreshMarkets();
      void qc.invalidateQueries({ queryKey: ["bets"] });
      void qc.invalidateQueries({ queryKey: ["settlements"] });
      toast.message("Market cancelled — stakes are refundable");
    });
    socket.on(WS.betConfirmed, () => {
      refreshMarkets();
      void qc.invalidateQueries({ queryKey: ["bets"] });
    });
    socket.on(`wallet:${WS.betConfirmed}`, (p: { betId: number }) => toast.success(`Bet #${p.betId} indexed`, { description: "Your bet now appears in My Bets." }));
    socket.on(WS.payoutClaimed, () => {
      void qc.invalidateQueries({ queryKey: ["bets"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    });
    socket.on(`wallet:${WS.payoutClaimed}`, (p: { amount: string; refund: boolean }) =>
      toast.success(p.refund ? "Refund received" : "Payout received", { description: `${formatUsdc(p.amount)} mUSDC transferred on-chain.` }),
    );
    socket.on("chain:reorg", () => {
      void qc.invalidateQueries();
      toast.warning("Chain reorganisation handled — data re-indexed");
    });
    return () => {
      socket.close();
    };
  }, [qc, address]);

  return { connected, head };
}
