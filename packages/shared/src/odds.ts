/**
 * Integer-only betting maths. Mirrors BettingMarket._payout exactly — every division floors, so an
 * off-chain quote can never promise more than the contract will lock. Cross-checked against the
 * deployed contract's `computePayout` in the API integration tests.
 */
export const ODDS_SCALE = 10_000n;
export const BPS = 10_000n;
export const USDC_DECIMALS = 6;
export const USDC_UNIT = 1_000_000n;
export const MIN_ODDS = 10_100n; // 1.01
export const MAX_ODDS = 1_000_000n; // 100.00

export interface Payout {
  gross: bigint;
  fee: bigint;
  net: bigint;
  profit: bigint;
}

export function computePayout(stake: bigint, odds: bigint, feeBps: bigint | number): Payout {
  if (stake < 0n || odds < 0n) throw new RangeError("stake and odds must be non-negative");
  const fb = BigInt(feeBps);
  const gross = (stake * odds) / ODDS_SCALE;
  const profit = gross > stake ? gross - stake : 0n;
  const fee = (profit * fb) / BPS;
  return { gross, fee, net: gross - fee, profit };
}

/** "2.5" | "2.50" | "2.5000" → 25000n. Rejects more than 4 decimal places rather than rounding. */
export function parseOdds(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) throw new RangeError(`invalid decimal odds: ${input}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole!) * ODDS_SCALE + BigInt(frac.padEnd(4, "0"));
}

/** 25000n → "2.50" (2 dp by default, as sportsbooks display; pass 4 for the exact on-chain value). */
export function formatOdds(odds: bigint | string, dp: 2 | 4 = 2): string {
  const v = BigInt(odds);
  const whole = v / ODDS_SCALE;
  const frac = (v % ODDS_SCALE).toString().padStart(4, "0");
  return dp === 4 ? `${whole}.${frac}` : `${whole}.${frac.slice(0, 2)}`;
}

/** Implied probability in basis points (1/odds), floored. */
export function impliedProbabilityBps(odds: bigint | string): number {
  const v = BigInt(odds);
  if (v === 0n) return 0;
  return Number((ODDS_SCALE * BPS) / v);
}

/** "12.5" → 12_500_000n. Rejects more than 6 decimals and negatives. */
export function parseUsdc(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new RangeError(`invalid amount: ${input}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole!) * USDC_UNIT + BigInt(frac.padEnd(6, "0"));
}

/** 12_500_000n → "12.50". Truncates (never rounds up) beyond `dp` decimals. */
export function formatUsdc(amount: bigint | string, dp = 2): string {
  const v = BigInt(amount);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(6, "0").slice(0, dp);
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${wholeStr}${dp > 0 ? `.${frac}` : ""}`;
}

/** Worst-case house liability for one market: max(0, max_i G_i − S). Mirrors BettingMarket._worstCase. */
export function marketLiability(grossByOutcome: readonly bigint[], totalStake: bigint): bigint {
  let max = 0n;
  for (const g of grossByOutcome) if (g > max) max = g;
  return max > totalStake ? max - totalStake : 0n;
}
