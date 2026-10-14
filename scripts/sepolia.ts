/**
 * pnpm sepolia <command> — the Sepolia TESTNET procedure. See docs/SEPOLIA_DEPLOYMENT.md.
 *
 *   preflight            read-only checks: config, keys, balances, RPC, database, git-ignore      (no transactions)
 *   db                   create + migrate the separate `fairplay_sepolia` database                    (no transactions)
 *   deploy [--broadcast] deploy MockUSDC, MockOracleAdapter, BettingMarket, wire roles, seed liquidity
 *   verify               read-only on-chain verification of the deployment and its roles              (no transactions)
 *   seed   [--broadcast] create a few fictional demo events/markets with the operator key
 *
 * `deploy` and `seed` SIMULATE by default. Broadcasting requires `--broadcast` AND confirming the deployer
 * address (typed at the prompt, or FAIRPLAY_CONFIRM_BROADCAST=<deployer address> when non-interactive).
 * Config comes from .env.sepolia (override with FAIRPLAY_ENV_FILE). Nothing here prints private keys.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import pg from "pg";
import { createPublicClient, formatEther, type Hex, http, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bettingMarketAbi, formatUsdc, mockUsdcAbi, oracleAdapterAbi } from "@fairplay/shared";
import { API_DIR, CONTRACTS_DIR, ROOT } from "./lib/local.ts";

const SEPOLIA = 11155111;
const ANVIL_DEV = new Set(
  [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9", "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  ].map((a) => a.toLowerCase()),
);
/**
 * Gas budget per account, measured on the Sepolia-fork rehearsal: the deployment script uses ~8.7M gas; the
 * operator ~0.3M per admin/seed transaction (budget 40); the reporter ~0.1M per result (budget 20).
 * Required ETH = budget × LIVE gas price × 3 (headroom), with a floor — so a gas spike is caught up front.
 */
const GAS_BUDGET = { deployer: 8_700_000n, operator: 12_000_000n, reporter: 2_000_000n };
const MIN_FLOOR = { deployer: parseEther("0.005"), operator: parseEther("0.003"), reporter: parseEther("0.001") };

const ENV_FILE = resolve(ROOT, process.env.FAIRPLAY_ENV_FILE ?? ".env.sepolia");
const args = process.argv.slice(3);
const BROADCAST = args.includes("--broadcast");

type Env = Record<string, string>;
function loadEnvFile(): Env {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`${ENV_FILE} not found — copy .env.sepolia.example to .env.sepolia and fill it in (see docs/SEPOLIA_DEPLOYMENT.md)`);
  }
  const env: Env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

const deploymentPath = (env: Env) => {
  const f = env.DEPLOYMENT_FILE ?? "../../packages/contracts/deployments/11155111.json";
  return isAbsolute(f) ? f : resolve(API_DIR, f);
};

const ok = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31mFAIL\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33mWARN\x1b[0m ${m}`);

/** Read-only. Returns derived addresses on success; prints every check. */
async function preflight(env: Env, opts: { quietOk?: boolean } = {}) {
  let failures = 0;
  const fail = (m: string) => (failures++, bad(m));
  const pass = (m: string) => !opts.quietOk && ok(m);
  console.log(`\nPreflight (${ENV_FILE.replace(ROOT + "/", "")}) — read-only, no transactions`);

  const placeholders = Object.entries(env).filter(([, v]) => /^<.*>$/.test(v)).map(([k]) => k);
  if (placeholders.length) fail(`unfilled placeholders: ${placeholders.join(", ")}`);
  else pass("no placeholders left");

  if (Number(env.CHAIN_ID) !== SEPOLIA) fail(`CHAIN_ID must be ${SEPOLIA} (got ${env.CHAIN_ID})`);
  else pass(`CHAIN_ID ${SEPOLIA}`);
  if (Number(env.NEXT_PUBLIC_CHAIN_ID) !== SEPOLIA) fail(`NEXT_PUBLIC_CHAIN_ID must be ${SEPOLIA}`);
  else pass("NEXT_PUBLIC_CHAIN_ID matches");
  if (/alchemy\.com\/v2\/|infura\.io\/v3\/|[?&](api)?key=|quiknode|\/v2\/[A-Za-z0-9_-]{16,}/i.test(env.NEXT_PUBLIC_RPC_URL ?? "")) {
    fail("NEXT_PUBLIC_RPC_URL looks like a KEYED RPC URL — it would be shipped to every browser; use a public key-less RPC");
  } else pass("browser RPC URL contains no apparent credential");

  // Keys → addresses (never printed). Each must be fresh: not an Anvil dev account, and all distinct.
  const addr = (k?: string) => {
    try {
      return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? privateKeyToAccount(k as Hex).address : null;
    } catch {
      return null;
    }
  };
  const operator = addr(env.OPERATOR_PRIVATE_KEY);
  const reporter = addr(env.ORACLE_REPORTER_PRIVATE_KEY);
  const plainDeployer = env.DEPLOYER_PRIVATE_KEY ? addr(env.DEPLOYER_PRIVATE_KEY) : null;
  const deployer = (plainDeployer ?? env.DEPLOYER_ADDRESS ?? "") as Hex;
  if (env.DEPLOYER_PRIVATE_KEY) warn("DEPLOYER_PRIVATE_KEY is a plaintext key in an env file — prefer an encrypted keystore (DEPLOYER_KEYSTORE_ACCOUNT)");
  if (!operator) fail("OPERATOR_PRIVATE_KEY is not a valid 32-byte hex key");
  if (!reporter) fail("ORACLE_REPORTER_PRIVATE_KEY is not a valid 32-byte hex key");
  if (!/^0x[0-9a-fA-F]{40}$/.test(deployer)) fail("deployer address missing (DEPLOYER_ADDRESS or DEPLOYER_PRIVATE_KEY)");
  if (plainDeployer && env.DEPLOYER_ADDRESS && !/^</.test(env.DEPLOYER_ADDRESS) && plainDeployer.toLowerCase() !== env.DEPLOYER_ADDRESS.toLowerCase()) {
    fail("DEPLOYER_ADDRESS does not match DEPLOYER_PRIVATE_KEY");
  }
  for (const [name, a] of [["deployer", deployer], ["operator", operator], ["reporter", reporter]] as const) {
    if (a && ANVIL_DEV.has(a.toLowerCase())) fail(`${name} is a PUBLIC Anvil development account — generate a fresh key`);
  }
  if (operator && reporter && deployer && new Set([deployer.toLowerCase(), operator.toLowerCase(), reporter.toLowerCase()]).size !== 3) {
    fail("deployer, operator and reporter must be three distinct accounts");
  } else if (operator && reporter) pass(`roles use three distinct fresh accounts (deployer ${deployer}, operator ${operator}, reporter ${reporter})`);

  // RPC + balances.
  let rpcChain: number | null = null;
  try {
    const client = createPublicClient({ transport: http(env.RPC_URL, { timeout: 15_000 }) });
    rpcChain = await client.getChainId();
    if (rpcChain !== SEPOLIA) fail(`RPC_URL reports chain ${rpcChain}, expected ${SEPOLIA}`);
    else pass(`RPC_URL reachable, chain ${rpcChain}, head block ${await client.getBlockNumber()}`);
    const gasPrice = await client.getGasPrice();
    pass(`live gas price ${Number(gasPrice) / 1e9} gwei`);
    for (const [name, a] of [["deployer", deployer], ["operator", operator], ["reporter", reporter]] as const) {
      if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
      const bal = await client.getBalance({ address: a as Hex });
      const byGas = GAS_BUDGET[name] * gasPrice * 3n;
      const min = byGas > MIN_FLOOR[name] ? byGas : MIN_FLOOR[name];
      if (bal < min) fail(`${name} ${a} has ${formatEther(bal)} ETH — needs ≥ ${formatEther(min)} test ETH (see faucets in the docs)`);
      else pass(`${name} balance ${formatEther(bal)} ETH (≥ ${formatEther(min)})`);
    }
  } catch (e) {
    fail(`RPC_URL not reachable: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!/^0x?$|^$/.test(env.ETHERSCAN_API_KEY ?? "") && env.ETHERSCAN_API_KEY) pass("ETHERSCAN_API_KEY set (source verification enabled)");
  else warn("ETHERSCAN_API_KEY empty — contracts will deploy without source verification");

  // Hygiene: the env file must be git-ignored.
  const ignored = spawnSync("git", ["check-ignore", "-q", ENV_FILE], { cwd: ROOT }).status === 0;
  if (!ignored) fail(`${ENV_FILE.replace(ROOT + "/", "")} is NOT git-ignored — it contains keys`);
  else pass("env file is git-ignored");

  // Database.
  try {
    const c = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    await c.connect();
    await c.end();
    pass("database reachable");
  } catch {
    warn("database not reachable yet — run `pnpm sepolia db` (needs `docker compose up -d postgres`)");
  }

  console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m` : "\n\x1b[32mPreflight passed.\x1b[0m");
  return { failures, deployer, operator: operator!, reporter: reporter!, rpcChain };
}

async function confirmBroadcast(deployer: string, what: string) {
  console.log(`\n\x1b[33mAbout to BROADCAST to chain ${SEPOLIA}: ${what}\x1b[0m`);
  const pre = process.env.FAIRPLAY_CONFIRM_BROADCAST;
  if (pre) {
    if (pre.toLowerCase() !== deployer.toLowerCase()) throw new Error("FAIRPLAY_CONFIRM_BROADCAST does not match the deployer address");
    return;
  }
  if (!process.stdin.isTTY) throw new Error("refusing to broadcast non-interactively without FAIRPLAY_CONFIRM_BROADCAST=<deployer address>");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type the deployer address (${deployer}) to confirm: `);
  rl.close();
  if (answer.trim().toLowerCase() !== deployer.toLowerCase()) throw new Error("confirmation did not match — nothing was broadcast");
}

async function deploy(env: Env) {
  const pf = await preflight(env, { quietOk: true });
  if (pf.failures) throw new Error("preflight failed — fix the issues above first");
  const out = deploymentPath(env);
  const forgeArgs = ["script", "script/Deploy.s.sol", "--rpc-url", env.RPC_URL!, "--sender", pf.deployer, "--slow"];
  if (!env.DEPLOYER_PRIVATE_KEY) forgeArgs.push("--account", env.DEPLOYER_KEYSTORE_ACCOUNT!);
  if (BROADCAST) {
    await confirmBroadcast(pf.deployer, `deploy MockUSDC + MockOracleAdapter + BettingMarket, ${env.HOUSE_LIQUIDITY ?? 0} mUSDC house liquidity`);
    forgeArgs.push("--broadcast");
    if (env.ETHERSCAN_API_KEY) forgeArgs.push("--verify", "--etherscan-api-key", env.ETHERSCAN_API_KEY);
  } else {
    console.log("\nSIMULATION ONLY (no --broadcast): forge will execute the deployment against a fork of the RPC and print the gas estimate.");
  }
  const r = spawnSync("forge", forgeArgs, {
    cwd: CONTRACTS_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(env.DEPLOYER_PRIVATE_KEY ? { DEPLOYER_PRIVATE_KEY: env.DEPLOYER_PRIVATE_KEY } : { DEPLOYER_ADDRESS: pf.deployer }),
      OPERATOR_ADDRESS: pf.operator,
      REPORTER_ADDRESS: pf.reporter,
      FEE_BPS: env.FEE_BPS ?? "200",
      ORACLE_FINALITY_SECONDS: env.ORACLE_FINALITY_SECONDS ?? "120",
      HOUSE_LIQUIDITY: env.HOUSE_LIQUIDITY ?? "0",
      DEPLOYMENT_OUT: out,
    },
  });
  if (r.status !== 0) throw new Error("forge script failed");
  if (BROADCAST) console.log(`\nDeployment written to ${out}. Next: pnpm sepolia verify`);
}

async function verify(env: Env) {
  const file = deploymentPath(env);
  if (!existsSync(file)) throw new Error(`${file} not found — deploy first`);
  const d = JSON.parse(readFileSync(file, "utf8"));
  const client = createPublicClient({ transport: http(env.RPC_URL) });
  let failures = 0;
  const check = (cond: boolean, m: string) => (cond ? ok(m) : (failures++, bad(m)));
  console.log(`\nVerifying ${file.replace(ROOT + "/", "")} on chain ${await client.getChainId()} — read-only`);
  check((await client.getChainId()) === d.chainId, `RPC chain matches deployment chain ${d.chainId}`);
  for (const [name, a] of [["BettingMarket", d.bettingMarket], ["MockUSDC", d.mockUSDC], ["MockOracleAdapter", d.oracleAdapter]] as const) {
    const code = await client.getCode({ address: a });
    check(!!code && code.length > 2, `${name} has code at ${a}`);
  }
  // Cross-check the addresses against forge's own broadcast receipts.
  const runLatest = join(CONTRACTS_DIR, "broadcast/Deploy.s.sol", String(d.chainId), "run-latest.json");
  if (existsSync(runLatest)) {
    const created = new Set(
      (JSON.parse(readFileSync(runLatest, "utf8")).transactions as Array<{ transactionType: string; contractAddress: string | null }>)
        .filter((t) => t.transactionType === "CREATE")
        .map((t) => t.contractAddress?.toLowerCase()),
    );
    check([d.bettingMarket, d.mockUSDC, d.oracleAdapter].every((a: string) => created.has(a.toLowerCase())), "addresses match forge's broadcast receipts");
  } else warn("no forge broadcast receipts found to cross-check addresses");

  const role = (r: string) => (r === "DEFAULT_ADMIN_ROLE" ? (`0x${"0".repeat(64)}` as Hex) : keccak256(toHex(r)));
  const has = (address: Hex, abi: typeof bettingMarketAbi | typeof oracleAdapterAbi, r: string, who: Hex) =>
    client.readContract({ address, abi, functionName: "hasRole", args: [role(r), who] } as never) as Promise<boolean>;
  check(await has(d.bettingMarket, bettingMarketAbi, "DEFAULT_ADMIN_ROLE", d.deployer), "deployer holds DEFAULT_ADMIN_ROLE");
  check(await has(d.bettingMarket, bettingMarketAbi, "MARKET_MANAGER_ROLE", d.operator), "operator holds MARKET_MANAGER_ROLE");
  check(await has(d.bettingMarket, bettingMarketAbi, "ODDS_MANAGER_ROLE", d.operator), "operator holds ODDS_MANAGER_ROLE");
  check(!(await has(d.bettingMarket, bettingMarketAbi, "LIQUIDITY_MANAGER_ROLE", d.operator)), "operator does NOT hold LIQUIDITY_MANAGER_ROLE");
  check(await has(d.oracleAdapter, oracleAdapterAbi, "REPORTER_ROLE", d.reporter), "reporter holds REPORTER_ROLE on the (mock, admin-controlled) oracle");
  check(!(await has(d.oracleAdapter, oracleAdapterAbi, "REPORTER_ROLE", d.operator)), "operator is NOT a reporter (separation of duties)");
  check(await client.readContract({ address: d.bettingMarket, abi: bettingMarketAbi, functionName: "allowedOracle", args: [d.oracleAdapter] }), "oracle adapter is allow-listed");
  check((await client.readContract({ address: d.mockUSDC, abi: mockUsdcAbi, functionName: "decimals" })) === 6, "MockUSDC has 6 decimals");
  const collateral = await client.readContract({ address: d.bettingMarket, abi: bettingMarketAbi, functionName: "collateral" });
  check(collateral.toLowerCase() === d.mockUSDC.toLowerCase(), "BettingMarket collateral is the deployed MockUSDC");
  const finality = await client.readContract({ address: d.oracleAdapter, abi: oracleAdapterAbi, functionName: "finalityDelay" });
  check(Number(finality) === d.oracleFinalitySeconds, `oracle dispute window ${finality}s`);
  const [required, held] = await client.readContract({ address: d.bettingMarket, abi: bettingMarketAbi, functionName: "solvency" });
  check(held >= required, `solvency: held ${formatUsdc(held)} ≥ owed ${formatUsdc(required)} mUSDC`);
  const house = await client.readContract({ address: d.bettingMarket, abi: bettingMarketAbi, functionName: "houseBalance" });
  console.log(`  INFO house liquidity ${formatUsdc(house)} mUSDC · deploy block ${d.deployBlock}`);
  check(d.deployBlock > 0 && BigInt(d.deployBlock) <= (await client.getBlockNumber()), "deployBlock is set (the indexer starts there, not at genesis)");
  if (env.EXPLORER_URL && env.EXPLORER_URL !== "none") for (const a of [d.bettingMarket, d.mockUSDC, d.oracleAdapter]) console.log(`  ${env.EXPLORER_URL}/address/${a}`);
  console.log(failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m` : "\n\x1b[32mDeployment verified.\x1b[0m");
  if (failures) process.exitCode = 1;
}

async function db(env: Env) {
  const url = new URL(env.DATABASE_URL!);
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  const exists = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (exists.rowCount === 0) {
    await c.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
    console.log(`created database ${name}`);
  } else console.log(`database ${name} exists`);
  await c.end();
  execFileSync("npx", ["prisma", "migrate", "deploy"], { cwd: API_DIR, stdio: "inherit", env: { ...process.env, DATABASE_URL: env.DATABASE_URL } });
}

async function seed(env: Env) {
  const pf = await preflight(env, { quietOk: true });
  if (pf.failures) throw new Error("preflight failed — fix the issues above first");
  const plan = [
    { sport: "football" as const, league: "Testnet Cup (demo)", homeTeam: "Northbridge FC", awayTeam: "Eastvale United", inHours: 72, odds: ["2.20", "3.30", "3.10"], labels: ["Northbridge FC", "Draw", "Eastvale United"] },
    { sport: "basketball" as const, league: "Testnet Hoops (demo)", homeTeam: "Harbor Hawks", awayTeam: "Summit Bears", inHours: 96, odds: ["1.85", "1.95"], labels: ["Harbor Hawks", "Summit Bears"] },
    { sport: "esports" as const, league: "FairPlay Invitational (demo)", homeTeam: "Team Alpha", awayTeam: "Team Omega", inHours: 48, odds: ["1.75", "2.10"], labels: ["Team Alpha", "Team Omega"] },
  ];
  console.log("\nSeed plan (fictional fixtures, created by the OPERATOR key — about 9 transactions):");
  for (const p of plan) console.log(`  ${p.sport.padEnd(10)} ${p.homeTeam} vs ${p.awayTeam}  odds ${p.odds.join(" / ")}`);
  if (!BROADCAST) {
    console.log("\nSIMULATION ONLY. Re-run with --broadcast to send these transactions.");
    return;
  }
  await confirmBroadcast(pf.deployer, "create the demo events and markets above with the operator key");
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const { loadEnv } = await import("../apps/api/src/env.ts");
  const { createContext } = await import("../apps/api/src/bootstrap.ts");
  const { createLogger } = await import("../apps/api/src/logger.ts");
  const ctx = createContext(loadEnv({ DEPLOYMENT_FILE: deploymentPath(env) }), createLogger("warn", false));
  const audit = { address: pf.deployer.toLowerCase(), ip: "sepolia-seed" };
  for (const p of plan) {
    const start = new Date(Date.now() + p.inHours * 3600_000);
    start.setUTCMinutes(0, 0, 0);
    const { event, txHash } = await ctx.markets.createEvent(audit, {
      sport: p.sport, league: p.league, homeTeam: p.homeTeam, awayTeam: p.awayTeam, startTime: start.toISOString(),
      description: "Fictional demonstration fixture on the Sepolia testnet.", featured: true,
    });
    const m = await ctx.markets.createMarket(audit, {
      eventId: event.id, type: p.odds.length === 3 ? "MATCH_RESULT_1X2" : "MONEYLINE", title: p.odds.length === 3 ? "Match result (90 min)" : "Moneyline",
      rules: "Fictional testnet fixture. Settles on the FairPlay mock oracle result (admin-controlled). Abandoned fixtures are refunded.",
      outcomes: p.odds.map((o, i) => ({ label: p.labels[i]!, odds: o })), minStake: "1", maxStake: "1000", maxLiability: "10000",
      openImmediately: true, simulateOdds: false, featured: true,
    });
    console.log(`  created ${p.homeTeam} vs ${p.awayTeam}: event tx ${txHash}, market #${m.onchainId}`);
  }
  await ctx.indexer.syncToHead();
  console.log(`  indexed; reconciliation: ${(await ctx.reconciler.run()).ok ? "OK" : "MISMATCH"}`);
  await ctx.db.$disconnect();
}

async function main() {
  const cmd = process.argv[2];
  const env = loadEnvFile();
  if (cmd === "preflight") {
    const r = await preflight(env);
    if (r.failures) process.exitCode = 1;
  } else if (cmd === "db") await db(env);
  else if (cmd === "deploy") await deploy(env);
  else if (cmd === "verify") await verify(env);
  else if (cmd === "seed") await seed(env);
  else {
    console.log("usage: pnpm sepolia <preflight|db|deploy [--broadcast]|verify|seed [--broadcast]>");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\n\x1b[31msepolia: ${e instanceof Error ? e.message : e}\x1b[0m`);
  process.exit(1);
});
