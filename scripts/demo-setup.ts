/**
 * npm run demo:setup — one command from nothing to a fully seeded local FairPlay.
 *
 *   1. start (or connect to) Anvil          5. reset the read model
 *   2. make sure PostgreSQL is up           6. fund accounts + deposit house liquidity
 *   3. migrate the database                 7. create the demo events & markets (through the real API service)
 *   4. build + deploy the contracts         8. play two short fixtures to completion for real settlement history
 *                                           9. index everything and reconcile against the contracts
 *
 * Every number shown in the app afterwards comes from transactions this script actually sent.
 * All fixtures are FICTIONAL demonstration data and are labelled as such in the UI.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { type Hex, maxUint256 } from "viem";
import { bettingMarketAbi, DEV_ACCOUNTS, mockUsdcAbi, parseOdds, parseUsdc } from "@fairplay/shared";
import { API_DIR, clients, CONTRACTS_DIR, loadDotEnv, ROOT, rpcAlive, run, sleep, startAnvil, STATE_DIR, step } from "./lib/local.ts";

const TOTAL = 9;
const HOUSE_LIQUIDITY = parseUsdc("250000");

type Seed = {
  sport: "football" | "basketball" | "esports";
  league: string;
  home: string;
  away: string;
  inHours: number;
  venue: string;
  featured?: boolean;
  description: string;
  markets: Array<{
    type: "MATCH_RESULT_1X2" | "MONEYLINE" | "TOTAL_OVER_UNDER" | "BOTH_TEAMS_TO_SCORE";
    title: string;
    rules: string;
    outcomes: Array<[label: string, odds: string]>;
    simulateOdds?: boolean;
    featured?: boolean;
    maxStake?: string;
    maxLiability?: string;
  }>;
};

const VOID_RULE =
  "If the fixture is abandoned, postponed or not completed within 48 hours of the scheduled start, the market is cancelled and every stake is refunded.";
const ORACLE_RULE = "Result source: FairPlay mock oracle — an admin-attested demonstration result, not an independent data feed.";

const football1x2 = (h: string, a: string, o: [string, string, string]) => ({
  type: "MATCH_RESULT_1X2" as const,
  title: "Match result (90 min)",
  rules: `Settles on the result after 90 minutes plus stoppage time; extra time and penalties do not count. ${VOID_RULE} ${ORACLE_RULE}`,
  outcomes: [
    [h, o[0]],
    ["Draw", o[1]],
    [a, o[2]],
  ] as Array<[string, string]>,
  simulateOdds: true,
  featured: true,
});
const goals = (o: [string, string]) => ({
  type: "TOTAL_OVER_UNDER" as const,
  title: "Total goals — over/under 2.5",
  rules: `Settles on total goals scored by both teams in 90 minutes plus stoppage time. ${VOID_RULE} ${ORACLE_RULE}`,
  outcomes: [
    ["Over 2.5", o[0]],
    ["Under 2.5", o[1]],
  ] as Array<[string, string]>,
});
const btts = (o: [string, string]) => ({
  type: "BOTH_TEAMS_TO_SCORE" as const,
  title: "Both teams to score",
  rules: `"Yes" wins if both teams score at least one goal in 90 minutes plus stoppage time. ${VOID_RULE} ${ORACLE_RULE}`,
  outcomes: [
    ["Yes", o[0]],
    ["No", o[1]],
  ] as Array<[string, string]>,
});
const moneyline = (h: string, a: string, o: [string, string], incl = "including overtime") => ({
  type: "MONEYLINE" as const,
  title: "Moneyline",
  rules: `Settles on the winner of the game ${incl}. ${VOID_RULE} ${ORACLE_RULE}`,
  outcomes: [
    [h, o[0]],
    [a, o[1]],
  ] as Array<[string, string]>,
  simulateOdds: true,
  featured: true,
});
const points = (line: string, o: [string, string]) => ({
  type: "TOTAL_OVER_UNDER" as const,
  title: `Total points — over/under ${line}`,
  rules: `Settles on combined points scored by both teams including overtime. ${VOID_RULE} ${ORACLE_RULE}`,
  outcomes: [
    [`Over ${line}`, o[0]],
    [`Under ${line}`, o[1]],
  ] as Array<[string, string]>,
});
const maps = (o: [string, string]) => ({
  type: "TOTAL_OVER_UNDER" as const,
  title: "Total maps — over/under 2.5",
  rules: `Best-of-three series. "Over 2.5" wins if the series goes to a third map. ${VOID_RULE} ${ORACLE_RULE}`,
  outcomes: [
    ["Over 2.5", o[0]],
    ["Under 2.5", o[1]],
  ] as Array<[string, string]>,
});

const UPCOMING: Seed[] = [
  {
    sport: "football", league: "Premier League (demo)", home: "Manchester City", away: "Arsenal", inHours: 30, venue: "Demo Stadium A", featured: true,
    description: "Fictional demonstration fixture. Not a real scheduled match.",
    markets: [football1x2("Manchester City", "Arsenal", ["2.10", "3.50", "3.40"]), goals(["1.80", "2.00"]), btts(["1.72", "2.10"])],
  },
  {
    sport: "football", league: "La Liga (demo)", home: "Real Madrid", away: "Barcelona", inHours: 54, venue: "Demo Stadium B", featured: true,
    description: "Fictional demonstration fixture. Not a real scheduled match.",
    markets: [football1x2("Real Madrid", "Barcelona", ["2.40", "3.60", "2.75"]), goals(["1.65", "2.20"])],
  },
  {
    sport: "football", league: "Premier League (demo)", home: "Liverpool", away: "Chelsea", inHours: 100, venue: "Demo Stadium C",
    description: "Fictional demonstration fixture. Not a real scheduled match.",
    markets: [football1x2("Liverpool", "Chelsea", ["1.95", "3.70", "3.80"]), btts(["1.66", "2.18"])],
  },
  {
    sport: "basketball", league: "Pro Basketball (demo)", home: "Lakers", away: "Celtics", inHours: 40, venue: "Demo Arena 1", featured: true,
    description: "Fictional demonstration game. Not a real scheduled game.",
    markets: [moneyline("Lakers", "Celtics", ["2.05", "1.80"]), points("221.5", ["1.90", "1.90"])],
  },
  {
    sport: "basketball", league: "Pro Basketball (demo)", home: "Warriors", away: "Nuggets", inHours: 76, venue: "Demo Arena 2",
    description: "Fictional demonstration game. Not a real scheduled game.",
    markets: [moneyline("Warriors", "Nuggets", ["2.30", "1.65"]), points("229.5", ["1.87", "1.93"])],
  },
  {
    sport: "esports", league: "FairPlay Invitational (demo)", home: "Team Alpha", away: "Team Omega", inHours: 22, venue: "Online", featured: true,
    description: "Fictional esports teams. Best-of-three demonstration series.",
    markets: [moneyline("Team Alpha", "Team Omega", ["1.75", "2.10"], "of the best-of-three series"), maps(["2.25", "1.62"])],
  },
];

async function main() {
  loadDotEnv();
  const rpcUrl = process.env.RPC_URL!;
  const port = Number(new URL(rpcUrl).port || 8545);

  // ── 1. chain ────────────────────────────────────────────────────────────────
  step(1, TOTAL, `Local chain at ${rpcUrl}`);
  const pidFile = join(STATE_DIR, "anvil.pid");
  const ourPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  const alive = await rpcAlive(rpcUrl);
  if (alive !== null && alive !== 31337) throw new Error(`RPC at ${rpcUrl} is chain ${alive}, expected 31337`);
  if (alive !== null && ourPid && processAlive(ourPid) && !process.argv.includes("--keep-chain")) {
    console.log(`  restarting the Anvil this script started earlier (pid ${ourPid}) for a clean chain`);
    process.kill(ourPid);
    await sleep(500);
  }
  if ((await rpcAlive(rpcUrl)) === null) {
    if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
      const pid = await startAnvil(port);
      writeFileSync(pidFile, String(pid));
      console.log(`  started anvil (pid ${pid}, 1s blocks) — log: .fairplay/anvil.log`);
    } else {
      throw new Error(`no chain at ${rpcUrl}`);
    }
  } else {
    console.log("  using the already-running chain");
  }

  // ── 2. database ─────────────────────────────────────────────────────────────
  step(2, TOTAL, "PostgreSQL");
  const dbUrl = process.env.DATABASE_URL!;
  if (!(await dbReachable(dbUrl))) {
    console.log("  not reachable — starting `docker compose up -d postgres`");
    run("docker", ["compose", "up", "-d", "postgres"], ROOT);
    for (let i = 0; i < 60 && !(await dbReachable(dbUrl)); i++) await sleep(500);
    if (!(await dbReachable(dbUrl))) throw new Error(`PostgreSQL not reachable at ${dbUrl}`);
  }
  console.log("  ok");

  // ── 3. migrations ───────────────────────────────────────────────────────────
  step(3, TOTAL, "Database migrations + Prisma client");
  run("npx", ["prisma", "migrate", "deploy"], API_DIR, { DATABASE_URL: dbUrl });
  run("npx", ["prisma", "generate"], API_DIR);
  console.log("  ok");

  // ── 4. contracts ────────────────────────────────────────────────────────────
  step(4, TOTAL, "Build + deploy contracts (MockUSDC, MockOracleAdapter, BettingMarket)");
  run("forge", ["build"], CONTRACTS_DIR);
  const deployOut = run("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow"], CONTRACTS_DIR, {
    DEPLOYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    OPERATOR_ADDRESS: DEV_ACCOUNTS[1].address,
    REPORTER_ADDRESS: DEV_ACCOUNTS[2].address,
    FEE_BPS: process.env.FEE_BPS ?? "200",
    ORACLE_FINALITY_SECONDS: process.env.ORACLE_FINALITY_SECONDS ?? "10",
  });
  for (const line of deployOut.split("\n").filter((l) => /MockUSDC|MockOracleAdapter|BettingMarket\s/.test(l))) console.log(`  ${line.trim()}`);
  const deploymentFile = join(CONTRACTS_DIR, "deployments/31337.json");
  const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));

  // ── 5. reset read model ─────────────────────────────────────────────────────
  step(5, TOTAL, "Reset the read model (database is rebuilt from the new chain)");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const { rows } = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'",
  );
  await client.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
  await client.end();
  console.log(`  truncated ${rows.length} tables`);

  // Imported only now: the API code depends on the Prisma client generated in step 3, which does not exist
  // yet on a fresh clone (a static import would crash before any step ran).
  const { createContext } = await import("../apps/api/src/bootstrap.ts");
  const { loadEnv } = await import("../apps/api/src/env.ts");
  const { createLogger } = await import("../apps/api/src/logger.ts");
  const env = loadEnv({ DEPLOYMENT_FILE: deploymentFile, LOG_LEVEL: "warn" });
  const log = createLogger("warn", false);
  const ctx = createContext(env, log);
  const { publicClient, wallet } = clients(rpcUrl);
  const usdc = deployment.mockUSDC as Hex;
  const book = deployment.bettingMarket as Hex;
  const send = async (_signer: ReturnType<typeof wallet>, fn: () => Promise<Hex>) => {
    const hash = await fn();
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
    return hash;
  };

  // ── 6. funding ──────────────────────────────────────────────────────────────
  step(6, TOTAL, "Fund demo accounts and deposit house liquidity");
  const admin = wallet(0);
  await send(admin, () => admin.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [admin.account.address, HOUSE_LIQUIDITY] }));
  await send(admin, () => admin.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [book, maxUint256] }));
  await send(admin, () => admin.writeContract({ address: book, abi: bettingMarketAbi, functionName: "depositLiquidity", args: [HOUSE_LIQUIDITY] }));
  console.log(`  house liquidity: 250,000 mUSDC deposited by ${DEV_ACCOUNTS[0].label}`);
  const funding: Array<[number, string]> = [
    [3, "75"], // demo bettor: just enough for one seeded bet — the demo flow starts at the faucet
    [4, "5000"],
    [5, "5000"],
    [6, "5000"],
  ];
  for (const [i, amount] of funding) {
    const w = wallet(i);
    await send(admin, () => admin.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [w.account.address, parseUsdc(amount)] }));
    await send(w, () => w.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [book, maxUint256] }));
    console.log(`  ${DEV_ACCOUNTS[i]!.label.padEnd(12)} ${w.account.address}  ${amount} mUSDC (+ approval)`);
  }

  // ── 7. events & markets ─────────────────────────────────────────────────────
  step(7, TOTAL, "Create demo events and markets (via the same service the admin API uses)");
  const audit = { address: DEV_ACCOUNTS[0].address.toLowerCase(), ip: "demo-setup" };
  const marketIds: Record<string, string[]> = {};
  for (const s of UPCOMING) {
    const start = new Date(Date.now() + s.inHours * 3600_000);
    start.setUTCMinutes(0, 0, 0);
    const { event } = await ctx.markets.createEvent(audit, {
      sport: s.sport, league: s.league, homeTeam: s.home, awayTeam: s.away, startTime: start.toISOString(), venue: s.venue,
      description: s.description, featured: !!s.featured,
    });
    const ids: string[] = [];
    for (const m of s.markets) {
      const r = await ctx.markets.createMarket(audit, {
        eventId: event.id, type: m.type, title: m.title, rules: m.rules,
        outcomes: m.outcomes.map(([label, odds]) => ({ label, odds })),
        minStake: "1", maxStake: m.maxStake ?? "5000", maxLiability: m.maxLiability ?? "50000",
        openImmediately: true, simulateOdds: !!m.simulateOdds, featured: !!m.featured,
      });
      ids.push(r.marketId);
    }
    marketIds[`${s.home} vs ${s.away}`] = ids;
    console.log(`  ${s.sport.padEnd(10)} ${`${s.home} vs ${s.away}`.padEnd(32)} ${s.markets.length} markets, kick-off ${start.toISOString().slice(0, 16)}Z`);
  }

  // Background betting activity from Bettors B–D (real transactions, odds read from the contract).
  const placeBet = async (acct: number, marketId: string, outcome: number, stake: string) => {
    const { onchainId } = await ctx.db.market.findUniqueOrThrow({ where: { id: marketId } });
    if (onchainId === null) throw new Error(`market ${marketId} has no on-chain id`);
    const odds = (await publicClient.readContract({ address: book, abi: bettingMarketAbi, functionName: "getOdds", args: [BigInt(onchainId)] }))[outcome]!;
    const w = wallet(acct);
    return send(w, () => w.writeContract({ address: book, abi: bettingMarketAbi, functionName: "placeBet", args: [BigInt(onchainId), BigInt(outcome), parseUsdc(stake), odds] }));
  };
  const bets: Array<[number, string, number, number, string]> = [
    [4, "Manchester City vs Arsenal", 0, 0, "250"],
    [5, "Manchester City vs Arsenal", 0, 2, "180"],
    [6, "Manchester City vs Arsenal", 1, 0, "120"],
    [4, "Real Madrid vs Barcelona", 0, 1, "90"],
    [5, "Lakers vs Celtics", 0, 1, "300"],
    [6, "Lakers vs Celtics", 1, 0, "75"],
    [4, "Team Alpha vs Team Omega", 0, 0, "140"],
    [6, "Team Alpha vs Team Omega", 0, 1, "60"],
    [5, "Warriors vs Nuggets", 0, 0, "110"],
  ];
  for (const [acct, ev, mIdx, outcome, stake] of bets) await placeBet(acct, marketIds[ev]![mIdx]!, outcome, stake);
  console.log(`  placed ${bets.length} background bets from Bettors B–D`);

  // ── 8. completed fixtures (real settlement + refund history) ────────────────
  step(8, TOTAL, "Play two short demo fixtures to completion (settled + cancelled) — ~30s");
  const kickoff = new Date(Date.now() + 25_000);
  const played = await ctx.markets.createEvent(
    audit,
    { sport: "basketball", league: "Pro Basketball (demo)", homeTeam: "Bucks", awayTeam: "Knicks", startTime: kickoff.toISOString(), venue: "Demo Arena 3", description: "Fictional demonstration game, simulated to completion during demo setup.", featured: false },
    { minLeadSeconds: 10 },
  );
  const playedMarket = await ctx.markets.createMarket(audit, {
    eventId: played.event.id, ...moneyline("Bucks", "Knicks", ["1.90", "1.95"]), simulateOdds: false, featured: false,
    outcomes: [{ label: "Bucks", odds: "1.90" }, { label: "Knicks", odds: "1.95" }], minStake: "1", maxStake: "5000", maxLiability: "50000", openImmediately: true,
  });
  const abandoned = await ctx.markets.createEvent(
    audit,
    { sport: "esports", league: "FairPlay Invitational (demo)", homeTeam: "Nebula Five", awayTeam: "Iron Lotus", startTime: kickoff.toISOString(), venue: "Online", description: "Fictional esports teams. Simulated as abandoned (server outage) during demo setup.", featured: false },
    { minLeadSeconds: 10 },
  );
  const abandonedMarket = await ctx.markets.createMarket(audit, {
    eventId: abandoned.event.id, ...moneyline("Nebula Five", "Iron Lotus", ["1.85", "2.00"], "of the best-of-three series"), simulateOdds: false, featured: false,
    outcomes: [{ label: "Nebula Five", odds: "1.85" }, { label: "Iron Lotus", odds: "2.00" }], minStake: "1", maxStake: "5000", maxLiability: "50000", openImmediately: true,
  });
  await placeBet(4, playedMarket.marketId, 0, "200"); // wins
  await placeBet(5, playedMarket.marketId, 1, "150"); // loses
  await placeBet(6, playedMarket.marketId, 0, "50"); // wins, left unclaimed
  await placeBet(3, abandonedMarket.marketId, 0, "75"); // DEMO BETTOR: refund left claimable for the demo
  await placeBet(5, abandonedMarket.marketId, 1, "40");

  process.stdout.write("  waiting for kick-off");
  while (true) {
    const b = await publicClient.getBlock();
    if (Number(b.timestamp) * 1000 > kickoff.getTime() + 1000) break;
    process.stdout.write(".");
    await sleep(1000);
  }
  console.log();
  await ctx.markets.closeMarket(audit, playedMarket.marketId).catch(() => undefined); // may already be closable by anyone
  await ctx.indexer.syncToHead(); // so questionIds are linked for the oracle calls below
  await ctx.markets.resolve(audit, playedMarket.marketId, 0, "FairPlay mock oracle — admin-attested demo result (Bucks won, simulated)");
  await ctx.markets.cancel(audit, abandonedMarket.marketId, "Series abandoned — simulated server outage (demo)", "oracle");
  process.stdout.write(`  oracle results published; waiting ${deployment.oracleFinalitySeconds}s dispute window`);
  await sleep((deployment.oracleFinalitySeconds + 2) * 1000);
  console.log();
  await ctx.markets.settle(playedMarket.marketId);
  await ctx.markets.settle(abandonedMarket.marketId);
  const winner = wallet(4);
  const winningBet = await publicClient.readContract({ address: book, abi: bettingMarketAbi, functionName: "getBetIds", args: [winner.account.address] });
  const lastBet = winningBet[winningBet.length - 1]!;
  await send(winner, () => winner.writeContract({ address: book, abi: bettingMarketAbi, functionName: "claim", args: [lastBet] }));
  const refunded = wallet(5);
  const rBets = await publicClient.readContract({ address: book, abi: bettingMarketAbi, functionName: "getBetIds", args: [refunded.account.address] });
  await send(refunded, () => refunded.writeContract({ address: book, abi: bettingMarketAbi, functionName: "claim", args: [rBets[rBets.length - 1]!] }));
  console.log("  Bucks vs Knicks: settled (Bucks), Bettor B claimed, Bettor D's win left claimable");
  console.log("  Nebula Five vs Iron Lotus: cancelled via oracle, Bettor C refunded, Demo bettor's refund left claimable");

  // ── 9. index + reconcile ────────────────────────────────────────────────────
  step(9, TOTAL, "Index all contract events and reconcile against the chain");
  await sleep(2500); // let the confirmation depth pass
  await ctx.indexer.syncToHead();
  const rec = await ctx.reconciler.run();
  const [events, markets, betRows, logs] = await Promise.all([ctx.db.event.count(), ctx.db.market.count(), ctx.db.betIndex.count(), ctx.db.chainLog.count()]);
  console.log(`  indexed ${logs} contract events → ${events} events, ${markets} markets, ${betRows} bets`);
  console.log(`  reconciliation: ${rec.ok ? "OK — read model matches the contracts" : `MISMATCH:\n    ${rec.mismatches.join("\n    ")}`}`);
  await ctx.db.$disconnect();

  console.log(`
\x1b[32mFairPlay demo is ready.\x1b[0m  (testnet tokens only — nothing here has value)

  Contracts   BettingMarket ${deployment.bettingMarket}
              MockUSDC      ${deployment.mockUSDC}
              Oracle (mock) ${deployment.oracleAdapter}

  Next:  pnpm dev:api      → API + indexer + keeper + simulated odds on http://127.0.0.1:${env.API_PORT}
         pnpm dev:web      → web app on http://localhost:3600
         pnpm demo:flow    → scripted 3-minute workflow against the running API

  Wallets (choose "Anvil dev wallet" in the app — the node signs; no keys in the browser):
         ${DEV_ACCOUNTS[3].address}  Demo bettor   (has a refundable bet; use the faucet for mUSDC)
         ${DEV_ACCOUNTS[0].address}  Admin (dev)   (sign in at /admin)
`);
  if (!rec.ok) process.exitCode = 1;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function dbReachable(url: string) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31mdemo:setup failed:\x1b[0m ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
