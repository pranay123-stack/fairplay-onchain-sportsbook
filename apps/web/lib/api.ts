"use client";
import { useQuery } from "@tanstack/react-query";
import type { BetDTO, EventDTO, MarketDTO, OracleResultDTO, PlatformStatsDTO, SettlementDTO, TransactionDTO } from "@fairplay/shared";
import { API_URL } from "./env";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const { token, headers, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `request failed (${res.status})`, e?.details);
  }
  return body as T;
}

export interface AppConfig {
  chainId: number;
  network: string;
  rpcUrl: string | null;
  explorerUrl: string | null;
  contracts: { bettingMarket: `0x${string}`; mockUSDC: `0x${string}`; oracleAdapter: `0x${string}` };
  services: { operator: string; reporter: string; deployer: string };
  deployBlock: number;
  oracleFinalitySeconds: number;
  feeBps: number;
}

export interface OddsHistoryPoint {
  odds: string[];
  version: number | null;
  status: "PENDING" | "CONFIRMED" | "FAILED";
  source: string;
  txHash: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface MarketDetail extends MarketDTO {
  event: { id: string; homeTeam: string; awayTeam: string; sport: string; league: string; startTime: string };
  oddsHistory: OddsHistoryPoint[];
  oracleReports: OracleResultDTO[];
  settlement: SettlementDTO | null;
  recentBets: BetDTO[];
}

export interface ChainEventRow {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  contract: string;
  eventName: string;
  args: Record<string, unknown>;
  timestamp: string;
}

export const qk = {
  config: ["config"] as const,
  events: (f: Record<string, unknown>) => ["events", f] as const,
  event: (id: string) => ["event", id] as const,
  market: (id: string) => ["market", id] as const,
  bets: (addr?: string) => ["bets", addr?.toLowerCase()] as const,
  stats: ["stats"] as const,
  settlements: ["settlements"] as const,
  chainEvents: ["chain-events"] as const,
  tx: (h: string) => ["tx", h] as const,
};

export const useAppConfig = () => useQuery({ queryKey: qk.config, queryFn: () => api<AppConfig>("/api/config"), staleTime: Infinity, retry: 2 });

export const useEvents = (f: { sport?: string; q?: string; status?: string } = {}) =>
  useQuery({
    queryKey: qk.events(f),
    queryFn: () => {
      const p = new URLSearchParams();
      if (f.sport) p.set("sport", f.sport);
      if (f.q) p.set("q", f.q);
      if (f.status) p.set("status", f.status);
      return api<EventDTO[]>(`/api/events?${p}`);
    },
  });

export const useEvent = (id: string) => useQuery({ queryKey: qk.event(id), queryFn: () => api<EventDTO>(`/api/events/${id}`) });
export const useMarket = (id: string | null) =>
  useQuery({ queryKey: qk.market(id ?? ""), queryFn: () => api<MarketDetail>(`/api/markets/${id}`), enabled: !!id });
export const useBets = (address?: string) =>
  useQuery({ queryKey: qk.bets(address), queryFn: () => api<BetDTO[]>(`/api/bets/${address}`), enabled: !!address });
export const useStats = () => useQuery({ queryKey: qk.stats, queryFn: () => api<PlatformStatsDTO>("/api/platform/stats"), refetchInterval: 10_000 });
export const useSettlements = () => useQuery({ queryKey: qk.settlements, queryFn: () => api<SettlementDTO[]>("/api/settlements") });
export const useChainEvents = () => useQuery({ queryKey: qk.chainEvents, queryFn: () => api<ChainEventRow[]>("/api/chain-events?limit=60") });
export const useTransaction = (hash: string) =>
  useQuery({
    queryKey: qk.tx(hash),
    queryFn: () => api<TransactionDTO>(`/api/transactions/${hash}`),
    refetchInterval: (q) => (q.state.data?.status === "pending" || q.state.data?.status === "not_found" ? 1500 : 6000),
  });
