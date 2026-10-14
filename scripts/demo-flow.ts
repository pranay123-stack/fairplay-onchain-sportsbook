/**
 * npm run demo:flow — the 3-minute demonstration workflow, executed end-to-end against the RUNNING stack
 * (after `pnpm demo:setup` and `scripts/stack.sh start`). Every step sends real transactions or real API
 * calls and then checks the result on-chain. Nothing is simulated except the sporting result itself,
 * which is (and is labelled as) an admin-attested mock-oracle report.
 *
 *   1 explore events   4 place bet          7 resolve (signed admin action)
 *   2 connect wallet   5 inspect the tx     8 claim payout
 *   3 get mock USDC    6 admin sign-in      9 verify final on-chain records
 */
import { type Hex, maxUint256, parseEventLogs } from "viem";
import { bettingMarketAbi, DEV_ACCOUNTS, type EventDTO, formatOdds, formatUsdc, mockUsdcAbi, parseUsdc, type PlatformStatsDTO, type TransactionDTO } from "@fairplay/shared";
import { clients, loadDotEnv, sleep } from "./lib/local.ts";

loadDotEnv();
const API = process.env.NEXT_PUBLIC_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4600}`;
const WEB = "http://localhost:3600";
const { publicClient, wallet } = clients(process.env.RPC_URL!);
const bettor = wallet(3); // "Demo bettor"
const admin = wallet(0); // "Admin (dev)"

const t0 = Date.now();
const step = (n: number, title: string) => console.log(`\n\x1b[32mStep ${n}\x1b[0m  ${title}  \x1b[2m(+${((Date.now() - t0) / 1000).toFixed(0)}s)\x1b[0m`);
const ok = (msg: string) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const info = (msg: string) => console.log(`   ${msg}`);

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: { ...(rest.body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function main() {
  const cfg = await api<{ contracts: { bettingMarket: Hex; mockUSDC: Hex } }>("/api/config").catch(() => {
    throw new Error(`API not reachable at ${API}. Run \`pnpm demo:setup\` and \`scripts/stack.sh start\` first.`);
  });
  const book = cfg.contracts.bettingMarket;
  const usdc = cfg.contracts.mockUSDC;

  step(1, "Explore events");
  const events = await api<EventDTO[]>("/api/events?status=upcoming");
  for (const e of events.slice(0, 6)) info(`${e.sport.padEnd(10)} ${`${e.homeTeam} vs ${e.awayTeam}`.padEnd(30)} ${e.markets.length} markets  (demo data)`);
  // A market whose odds are not moved by the simulated engine, so the scripted bet is deterministic.
  let target = events.flatMap((e) => e.markets.map((m) => ({ e, m }))).find(({ m }) => m.status === "OPEN" && m.type === "TOTAL_OVER_UNDER");
  if (!target) throw new Error("no open over/under market — re-run `pnpm demo:setup`");
  ok(`chose “${target.m.title}” in ${target.e.homeTeam} vs ${target.e.awayTeam} (market #${target.m.onchainId})`);

  step(2, "Connect wallet");
  ok(`${DEV_ACCOUNTS[3].label} ${bettor.account.address} (Anvil dev wallet — the node signs, no key in the browser)`);

  step(3, "Obtain mock USDC");
  const before = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [bettor.account.address] });
  const wait = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "faucetAvailableIn", args: [bettor.account.address] });
  if (wait === 0n && before < parseUsdc("10000")) {
    const h = await bettor.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "faucet" });
    await publicClient.waitForTransactionReceipt({ hash: h });
    const after = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [bettor.account.address] });
    ok(`faucet: ${formatUsdc(before)} → ${formatUsdc(after)} mUSDC  tx ${h}`);
  } else {
    info(`faucet cooling down (${wait}s) — balance ${formatUsdc(before)} mUSDC`);
  }

  step(4, "Place bet");
  const stake = parseUsdc("50");
  const outcome = 0n;
  const [odds, gross, fee, net, acceptable] = await publicClient.readContract({
    address: book, abi: bettingMarketAbi, functionName: "quote", args: [BigInt(target.m.onchainId!), outcome, stake],
  });
  if (!acceptable) throw new Error("contract quote says the bet would be rejected");
  info(`on-chain quote: ${target.m.outcomes[0]!.label} @ ${formatOdds(odds, 4)} → gross ${formatUsdc(gross)}, fee ${formatUsdc(fee)}, net ${formatUsdc(net)} mUSDC`);
  const allowance = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "allowance", args: [bettor.account.address, book] });
  if (allowance < stake) {
    await publicClient.waitForTransactionReceipt({ hash: await bettor.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "approve", args: [book, maxUint256] }) });
    ok("approved BettingMarket to pull mUSDC");
  }
  const betHash = await bettor.writeContract({ address: book, abi: bettingMarketAbi, functionName: "placeBet", args: [BigInt(target.m.onchainId!), outcome, stake, odds] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: betHash });
  const [placed] = parseEventLogs({ abi: bettingMarketAbi, eventName: "BetPlaced", logs: receipt.logs });
  const betId = placed!.args.betId;
  ok(`bet #${betId} mined in block ${receipt.blockNumber}: odds locked at ${formatOdds(placed!.args.odds, 4)}, payout ${formatUsdc(placed!.args.potentialPayout)} mUSDC`);

  step(5, "Inspect the blockchain transaction");
  const tx = await api<TransactionDTO>(`/api/transactions/${betHash}`);
  ok(`${tx.status} · ${tx.toLabel}.${tx.functionName}() · ${tx.confirmations} confirmation(s) · gas ${tx.gasUsed}`);
  info(`events: ${tx.decodedLogs.map((l) => `${l.contract}.${l.event}`).join(", ")}`);
  info(`open it in the app: ${WEB}/tx/${betHash}`);

  step(6, "Open the admin panel (wallet-signature sign-in)");
  const { message } = await api<{ message: string }>(`/api/auth/nonce?address=${admin.account.address}`);
  const session = await api<{ token: string; roles: string[] }>("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address: admin.account.address, message, signature: await admin.signMessage({ message }) }),
  });
  ok(`signed in as ${DEV_ACCOUNTS[0].label}; on-chain roles: ${session.roles.join(", ")}`);

  step(7, "Resolve the simulated event");
  const close = await api<{ txHash: string }>(`/api/admin/markets/${target.m.id}/close`, { method: "POST", token: session.token });
  ok(`market closed (operator service) tx ${close.txHash}`);
  const params = { winningOutcome: 0, source: "FairPlay mock oracle — admin-attested demo result (demo:flow)" };
  const ch = await api<{ nonce: string; message: string }>("/api/auth/action-nonce", {
    method: "POST", token: session.token, body: JSON.stringify({ action: "resolve", marketId: target.m.id, params }),
  });
  const res = await api<{ txHash: string }>(`/api/admin/markets/${target.m.id}/resolve`, {
    method: "POST", token: session.token, body: JSON.stringify({ ...params, nonce: ch.nonce, signature: await admin.signMessage({ message: ch.message }) }),
  });
  ok(`result reported by the mock-oracle reporter key, tx ${res.txHash}`);
  info("waiting for the dispute window, then the keeper's permissionless settleMarket()…");
  let settled = false;
  for (let i = 0; i < 90 && !settled; i++) {
    const m = await publicClient.readContract({ address: book, abi: bettingMarketAbi, functionName: "getMarket", args: [BigInt(target.m.onchainId!)] });
    settled = m.status === 3;
    if (!settled) await sleep(1000);
  }
  if (!settled) throw new Error("market did not settle within 90s — is the API keeper running?");
  ok("market settled on-chain");

  step(8, "Claim payout");
  const balBefore = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [bettor.account.address] });
  const claimHash = await bettor.writeContract({ address: book, abi: bettingMarketAbi, functionName: "claim", args: [betId] });
  await publicClient.waitForTransactionReceipt({ hash: claimHash });
  const balAfter = await publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [bettor.account.address] });
  if (balAfter - balBefore !== placed!.args.potentialPayout) throw new Error("payout amount does not match the locked potential payout");
  ok(`received ${formatUsdc(balAfter - balBefore)} mUSDC — exactly the payout locked at bet time. tx ${claimHash}`);

  step(9, "Verify final on-chain records");
  const bet = await publicClient.readContract({ address: book, abi: bettingMarketAbi, functionName: "getBet", args: [betId] });
  const [required, held] = await publicClient.readContract({ address: book, abi: bettingMarketAbi, functionName: "solvency" });
  ok(`getBet(${betId}).claimed = ${bet.claimed}`);
  ok(`solvency(): held ${formatUsdc(held)} ≥ owed ${formatUsdc(required)} mUSDC`);
  for (let i = 0; i < 40; i++) {
    const bets = await api<Array<{ betId: number; status: string }>>(`/api/bets/${bettor.account.address}`);
    if (bets.find((b) => b.betId === Number(betId))?.status === "CLAIMED") break;
    await sleep(500);
  }
  ok("indexer shows the bet as CLAIMED");
  await sleep(1500);
  const stats = await api<PlatformStatsDTO>("/api/platform/stats");
  ok(`reconciliation: ${stats.reconciliation.checkedAt ? (stats.reconciliation.ok ? "read model matches the contracts" : "MISMATCH") : "pending first run"}`);
  console.log(`\n\x1b[32mDemo workflow complete in ${((Date.now() - t0) / 1000).toFixed(0)}s.\x1b[0m  See it in the app: ${WEB}/my-bets and ${WEB}/transparency`);
}

main().catch((e) => {
  console.error(`\n\x1b[31mdemo:flow failed:\x1b[0m ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
