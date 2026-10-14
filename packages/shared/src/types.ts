import type { BetStatus, MarketLifecycle, MarketType, OracleStatus, Sport } from "./constants";

/** All token amounts and odds are decimal strings of base units (mUSDC 1e6, odds 1e4) — never floats. */
export interface OutcomeDTO {
  index: number;
  label: string;
  odds: string;
  stake: string;
  grossPayout: string;
  betCount: number;
}

export interface PendingOddsDTO {
  odds: string[];
  txHash: string | null;
  proposedAt: string;
  source: "simulated-engine" | "admin";
}

export interface OracleResultDTO {
  status: OracleStatus;
  winningOutcome: number | null;
  reporter: string;
  reportedAt: string;
  finalAt: string;
  source: string;
  txHash: string;
}

export interface MarketDTO {
  id: string;
  onchainId: number | null;
  eventId: string;
  type: MarketType;
  title: string;
  rules: string;
  status: MarketLifecycle;
  outcomes: OutcomeDTO[];
  closeTime: string;
  feeBps: number;
  minStake: string;
  maxStake: string;
  maxLiability: string;
  totalStake: string;
  reserved: string;
  oddsVersion: number;
  questionId: string | null;
  winningOutcome: number | null;
  settledAt: string | null;
  featured: boolean;
  createTxHash: string | null;
  pendingOdds: PendingOddsDTO | null;
  oracleResult: OracleResultDTO | null;
  betCount: number;
}

export interface EventDTO {
  id: string;
  onchainId: number | null;
  sport: Sport;
  league: string;
  homeTeam: string;
  awayTeam: string;
  venue: string | null;
  description: string | null;
  startTime: string;
  featured: boolean;
  isDemo: boolean;
  createTxHash: string | null;
  markets: MarketDTO[];
}

export interface BetDTO {
  betId: number;
  bettor: string;
  marketId: string | null;
  eventId: string | null;
  marketOnchainId: number;
  marketTitle: string | null;
  eventLabel: string | null;
  outcomeIndex: number;
  outcomeLabel: string | null;
  stake: string;
  odds: string;
  potentialPayout: string;
  status: BetStatus;
  claimed: boolean;
  /** true if the claim was a refund of a cancelled market; null until claimed */
  refund: boolean | null;
  payoutAmount: string | null;
  placedTxHash: string;
  placedBlock: number;
  placedAt: string;
  claimTxHash: string | null;
}

export interface SettlementDTO {
  marketOnchainId: number;
  marketTitle: string | null;
  eventLabel: string | null;
  kind: "SETTLED" | "CANCELLED";
  winningOutcome: number | null;
  winningLabel: string | null;
  totalStake: string;
  winnersPayout: string;
  fees: string;
  houseDelta: string;
  oracleReporter: string | null;
  resultReportedAt: string | null;
  reason: string | null;
  txHash: string;
  blockNumber: number;
  at: string;
}

export interface PlatformStatsDTO {
  chainId: number;
  network: string;
  contracts: { bettingMarket: string; mockUSDC: string; oracleAdapter: string };
  deployBlock: number;
  onchain: {
    escrowHeld: string;
    escrowRequired: string;
    houseBalance: string;
    totalReserved: string;
    freeLiquidity: string;
    openStake: string;
    outstandingClaims: string;
    accruedFees: string;
    feeBps: number;
    paused: boolean;
    betCount: number;
    marketCount: number;
    oracleFinalitySeconds: number;
  };
  indexer: {
    lastIndexedBlock: number;
    chainHead: number;
    confirmations: number;
    lagBlocks: number;
    reorgsHandled: number;
  };
  reconciliation: {
    ok: boolean;
    checkedAt: string | null;
    checkedMarkets: number;
    checkedBets: number;
    mismatches: string[];
  };
  totals: { events: number; markets: number; bets: number; settledMarkets: number; cancelledMarkets: number; volume: string };
  oddsEngine: { enabled: boolean; intervalSeconds: [number, number]; simulated: true };
}

export interface TransactionDTO {
  hash: string;
  status: "success" | "reverted" | "pending" | "not_found";
  blockNumber: number | null;
  blockHash: string | null;
  timestamp: string | null;
  from: string | null;
  to: string | null;
  toLabel: string | null;
  gasUsed: string | null;
  confirmations: number;
  functionName: string | null;
  decodedLogs: Array<{ contract: string; address: string; event: string; args: Record<string, string> }>;
  explorerUrl: string | null;
}

export interface DeploymentInfo {
  chainId: number;
  deployBlock: number;
  bettingMarket: `0x${string}`;
  mockUSDC: `0x${string}`;
  oracleAdapter: `0x${string}`;
  deployer: `0x${string}`;
  operator: `0x${string}`;
  reporter: `0x${string}`;
  feeBps: number;
  oracleFinalitySeconds: number;
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
