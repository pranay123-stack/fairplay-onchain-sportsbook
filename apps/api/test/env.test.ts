import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { chainFor } from "../src/chain.ts";
import { loadEnv } from "../src/env.ts";

const dir = mkdtempSync(join(tmpdir(), "fairplay-env-"));
const sepoliaDeployment = join(dir, "11155111.json");
writeFileSync(
  sepoliaDeployment,
  JSON.stringify({ chainId: 11155111, deployBlock: 7_000_000, bettingMarket: "0x" + "1".repeat(40), mockUSDC: "0x" + "2".repeat(40), oracleAdapter: "0x" + "3".repeat(40), deployer: "0x" + "4".repeat(40), operator: "0x" + "5".repeat(40), reporter: "0x" + "6".repeat(40), feeBps: 200, oracleFinalitySeconds: 120 }),
);
const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ANVIL_KEY_9 = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";

/** Only the variables a Sepolia operator would set — nothing inherited from the local .env. */
const sepolia = (over: Record<string, string | undefined> = {}) => {
  const keep = { ...process.env };
  for (const k of ["ODDS_ENGINE_ENABLED", "INDEXER_CONFIRMATIONS", "INDEXER_BATCH_BLOCKS", "INDEXER_POLL_MS", "KEEPER_INTERVAL_MS", "RPC_POLLING_MS", "TX_TIMEOUT_MS", "EXPLORER_URL"]) {
    delete process.env[k];
  }
  try {
    return loadEnv({
      CHAIN_ID: "11155111",
      RPC_URL: "https://ethereum-sepolia-rpc.publicnode.com",
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5482/fairplay_sepolia",
      DEPLOYMENT_FILE: sepoliaDeployment,
      OPERATOR_PRIVATE_KEY: generatePrivateKey(),
      ORACLE_REPORTER_PRIVATE_KEY: generatePrivateKey(),
      ...over,
    });
  } finally {
    process.env = keep;
  }
};

describe("Sepolia configuration", () => {
  it("applies testnet-safe defaults and the Sepolia chain", () => {
    const env = sepolia();
    expect(env.CHAIN_ID).toBe(11155111);
    expect(env.ODDS_ENGINE_ENABLED).toBe(false); // never burn test ETH on simulated odds by default
    expect(env.INDEXER_CONFIRMATIONS).toBe(3);
    expect(env.INDEXER_BATCH_BLOCKS).toBe(500);
    expect(env.RPC_POLLING_MS).toBe(4000);
    expect(env.TX_TIMEOUT_MS).toBe(180_000);
    expect(env.EXPLORER_URL).toBe("https://sepolia.etherscan.io");
    const chain = chainFor(env);
    expect(chain.id).toBe(11155111);
    expect(chain.rpcUrls.default.http[0]).toBe("https://ethereum-sepolia-rpc.publicnode.com");
  });

  it("respects explicit overrides", () => {
    const env = sepolia({ ODDS_ENGINE_ENABLED: "true", INDEXER_CONFIRMATIONS: "6" });
    expect(env.ODDS_ENGINE_ENABLED).toBe(true);
    expect(env.INDEXER_CONFIRMATIONS).toBe(6);
  });

  it("refuses every public Anvil development key", () => {
    expect(() => sepolia({ OPERATOR_PRIVATE_KEY: ANVIL_KEY_1 })).toThrow(/Anvil development key/);
    expect(() => sepolia({ ORACLE_REPORTER_PRIVATE_KEY: ANVIL_KEY_9 })).toThrow(/Anvil development key/);
  });

  it("requires distinct operator and reporter keys", () => {
    const k = generatePrivateKey();
    expect(() => sepolia({ OPERATOR_PRIVATE_KEY: k, ORACLE_REPORTER_PRIVATE_KEY: k })).toThrow(/different keys/);
  });

  it("rejects unsupported chains and mismatched deployment files", () => {
    expect(() => sepolia({ CHAIN_ID: "1" })).toThrow(/CHAIN_ID must be 31337/);
    expect(() => sepolia({ CHAIN_ID: "31337" })).toThrow(/Deployment file is for chain 11155111/);
  });
});
