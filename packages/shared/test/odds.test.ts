import { describe, expect, it } from "vitest";
import { buildActionMessage, computePayout, formatOdds, formatUsdc, impliedProbabilityBps, marketLiability, parseOdds, parseUsdc } from "../src/index";

describe("odds parsing/formatting (1e4 fixed point)", () => {
  it("parses decimal odds exactly", () => {
    expect(parseOdds("2.5")).toBe(25_000n);
    expect(parseOdds("2.50")).toBe(25_000n);
    expect(parseOdds("1.0101")).toBe(10_101n);
    expect(parseOdds("100")).toBe(1_000_000n);
  });
  it("rejects ambiguous or unsafe input instead of rounding", () => {
    for (const bad of ["", "abc", "-2", "2.12345", "1e3", "2,5", " "]) expect(() => parseOdds(bad)).toThrow();
  });
  it("formats", () => {
    expect(formatOdds(25_000n)).toBe("2.50");
    expect(formatOdds("10101", 4)).toBe("1.0101");
    expect(formatOdds(1_000_000n)).toBe("100.00");
  });
  it("implied probability", () => {
    expect(impliedProbabilityBps(20_000n)).toBe(5_000);
    expect(impliedProbabilityBps(30_000n)).toBe(3_333);
  });
});

describe("mUSDC amounts (6 decimals)", () => {
  it("parses and formats without floating point", () => {
    expect(parseUsdc("12.5")).toBe(12_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(formatUsdc(1_234_567_891n)).toBe("1,234.56");
    expect(formatUsdc(-5_000_000n)).toBe("-5.00");
    expect(formatUsdc(1n, 6)).toBe("0.000001");
    expect(() => parseUsdc("1.0000001")).toThrow();
    expect(() => parseUsdc("-1")).toThrow();
  });
});

describe("payout maths", () => {
  it("matches the contract's worked example", () => {
    expect(computePayout(100_000_000n, 25_000n, 200)).toEqual({ gross: 250_000_000n, fee: 3_000_000n, net: 247_000_000n, profit: 150_000_000n });
  });
  it("never pays below stake and floors every division", () => {
    expect(computePayout(1n, 10_100n, 200)).toEqual({ gross: 1n, fee: 0n, net: 1n, profit: 0n });
    expect(computePayout(3_333_333n, 33_333n, 200).gross).toBe(11_110_998n);
  });
  it("market liability nets losing stakes against the worst outcome", () => {
    expect(marketLiability([1_000n, 1_020n, 840n], 1_000n)).toBe(20n);
    expect(marketLiability([500n, 500n], 1_000n)).toBe(0n);
  });
});

describe("action message", () => {
  it("is canonical regardless of parameter order", () => {
    const base = { domain: "d", address: "0xa", action: "resolve", marketId: "m", nonce: "n", expiresAt: "t" };
    expect(buildActionMessage({ ...base, params: { b: 1, a: "x" } })).toBe(buildActionMessage({ ...base, params: { a: "x", b: 1 } }));
    expect(buildActionMessage({ ...base, params: { winningOutcome: 0 } })).not.toBe(buildActionMessage({ ...base, params: { winningOutcome: 1 } }));
  });
});
