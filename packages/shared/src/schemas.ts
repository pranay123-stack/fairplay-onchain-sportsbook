import { z } from "zod";
import { MARKET_TYPES, SPORTS } from "./constants";
import { MAX_ODDS, MIN_ODDS, parseOdds, parseUsdc } from "./odds";

export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "invalid address");
export const txHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, "invalid transaction hash");
export const signatureSchema = z.string().regex(/^0x[a-fA-F0-9]+$/, "invalid signature");
export const uuidSchema = z.string().uuid();

/** Decimal odds string, e.g. "2.50", validated against the contract's [1.01, 100.00] range. */
export const oddsInputSchema = z.string().refine((s) => {
  try {
    const v = parseOdds(s);
    return v >= MIN_ODDS && v <= MAX_ODDS;
  } catch {
    return false;
  }
}, "odds must be a decimal between 1.01 and 100.00 with at most 4 decimals");

/** Human mUSDC amount string, e.g. "25" or "12.5". */
export const usdcInputSchema = z.string().refine((s) => {
  try {
    return parseUsdc(s) > 0n;
  } catch {
    return false;
  }
}, "amount must be a positive number with at most 6 decimals");

export const createEventSchema = z.object({
  sport: z.enum(SPORTS),
  league: z.string().trim().min(2).max(80),
  homeTeam: z.string().trim().min(2).max(60),
  awayTeam: z.string().trim().min(2).max(60),
  startTime: z.string().datetime({ offset: true }),
  venue: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
  featured: z.boolean().default(false),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const createMarketSchema = z.object({
  eventId: uuidSchema,
  type: z.enum(MARKET_TYPES),
  title: z.string().trim().min(3).max(80),
  rules: z.string().trim().min(10).max(1000),
  outcomes: z
    .array(z.object({ label: z.string().trim().min(1).max(40), odds: oddsInputSchema }))
    .min(2)
    .max(8),
  minStake: usdcInputSchema.default("1"),
  maxStake: usdcInputSchema.default("5000"),
  maxLiability: usdcInputSchema.default("50000"),
  openImmediately: z.boolean().default(true),
});
export type CreateMarketInput = z.infer<typeof createMarketSchema>;

export const patchMarketSchema = z
  .object({
    title: z.string().trim().min(3).max(80).optional(),
    rules: z.string().trim().min(10).max(1000).optional(),
    featured: z.boolean().optional(),
    odds: z.array(oddsInputSchema).min(2).max(8).optional(),
    status: z.enum(["OPEN"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to update");
export type PatchMarketInput = z.infer<typeof patchMarketSchema>;

/** High-impact actions carry a fresh, single-use wallet signature over their exact parameters. */
export const signedActionSchema = z.object({
  nonce: z.string().min(16).max(64),
  signature: signatureSchema,
});

export const resolveMarketSchema = signedActionSchema.extend({
  winningOutcome: z.number().int().min(0).max(7),
  source: z.string().trim().min(3).max(120).default("FairPlay mock oracle — admin-attested demo result"),
});
export type ResolveMarketInput = z.infer<typeof resolveMarketSchema>;

export const cancelMarketSchema = signedActionSchema.extend({
  reason: z.string().trim().min(3).max(200),
  via: z.enum(["oracle", "manager"]).default("manager"),
});
export type CancelMarketInput = z.infer<typeof cancelMarketSchema>;

export const authNonceQuerySchema = z.object({ address: addressSchema });
export const authVerifySchema = z.object({
  address: addressSchema,
  message: z.string().min(20).max(2000),
  signature: signatureSchema,
});
export const actionNonceSchema = z.object({
  action: z.enum(["resolve", "cancel"]),
  marketId: uuidSchema,
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type ActionNonceInput = z.infer<typeof actionNonceSchema>;

export const listEventsQuerySchema = z.object({
  sport: z.enum(SPORTS).optional(),
  q: z.string().trim().max(60).optional(),
  status: z.enum(["upcoming", "closed", "settled", "all"]).default("all"),
  featured: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/**
 * Canonical text a wallet signs to authorise one admin action. Built identically on server and client;
 * the server rebuilds it from the request and verifies the signature against the session address.
 */
export function buildActionMessage(a: {
  domain: string;
  address: string;
  action: string;
  marketId: string;
  params: Record<string, string | number>;
  nonce: string;
  expiresAt: string;
}): string {
  const params = Object.keys(a.params)
    .sort()
    .map((k) => `${k}=${a.params[k]}`)
    .join("&");
  return [
    `${a.domain} admin action authorisation`,
    "",
    `Admin: ${a.address}`,
    `Action: ${a.action}`,
    `Market: ${a.marketId}`,
    `Parameters: ${params || "(none)"}`,
    `Nonce: ${a.nonce}`,
    `Expires: ${a.expiresAt}`,
    "",
    "Signing this message authorises exactly this action once. It does not move funds.",
  ].join("\n");
}
