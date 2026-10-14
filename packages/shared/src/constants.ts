/** Mirrors BettingMarket.MarketStatus (uint8 order matters). */
export const MARKET_STATUS = ["PENDING", "OPEN", "CLOSED", "SETTLED", "CANCELLED"] as const;
export type MarketStatus = (typeof MARKET_STATUS)[number];
/** Off-chain only: created in the DB, on-chain transaction not yet confirmed. */
export type MarketLifecycle = MarketStatus | "DRAFT";

/** Mirrors BettingMarket.BetStatus. */
export const BET_STATUS = ["NONE", "OPEN", "WON", "LOST", "REFUNDABLE", "CLAIMED"] as const;
export type BetStatus = (typeof BET_STATUS)[number];

/** Mirrors IOracleAdapter.ResultStatus. */
export const ORACLE_STATUS = ["NONE", "RESOLVED", "CANCELLED"] as const;
export type OracleStatus = (typeof ORACLE_STATUS)[number];

export const SPORTS = ["football", "basketball", "esports"] as const;
export type Sport = (typeof SPORTS)[number];

export const MARKET_TYPES = ["MATCH_RESULT_1X2", "MONEYLINE", "TOTAL_OVER_UNDER", "BOTH_TEAMS_TO_SCORE"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

export const MARKET_TYPE_LABEL: Record<MarketType, string> = {
  MATCH_RESULT_1X2: "Match result (1X2)",
  MONEYLINE: "Moneyline",
  TOTAL_OVER_UNDER: "Total points / goals",
  BOTH_TEAMS_TO_SCORE: "Both teams to score",
};

export const LOCAL_CHAIN_ID = 31337;
export const SEPOLIA_CHAIN_ID = 11155111;

/** Socket.IO event names — the single list both server and client import. */
export const WS = {
  eventCreated: "event:created",
  marketCreated: "market:created",
  marketStatus: "market:status",
  oddsPending: "odds:pending",
  oddsUpdated: "odds:updated",
  betConfirmed: "bet:confirmed",
  resultReported: "result:reported",
  marketSettled: "market:settled",
  marketCancelled: "market:cancelled",
  payoutClaimed: "payout:claimed",
  chainHead: "chain:head",
} as const;
export type WsEvent = (typeof WS)[keyof typeof WS];

/**
 * Anvil's well-known development accounts used by the local demo. ADDRESSES ONLY — the frontend never
 * holds a key; the local "Anvil dev wallet" asks the node (which has these accounts unlocked) to sign.
 */
export const DEV_ACCOUNTS = [
  { index: 0, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", label: "Admin (dev)", role: "admin" },
  { index: 1, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", label: "Operator service", role: "service" },
  { index: 2, address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", label: "Mock oracle reporter", role: "service" },
  { index: 3, address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", label: "Demo bettor", role: "bettor" },
  { index: 4, address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", label: "Bettor B", role: "bettor" },
  { index: 5, address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", label: "Bettor C", role: "bettor" },
  { index: 6, address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", label: "Bettor D", role: "bettor" },
] as const;
