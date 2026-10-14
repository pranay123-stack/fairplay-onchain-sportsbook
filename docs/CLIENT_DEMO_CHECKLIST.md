# Client demo checklist

Use this before recording or presenting FairPlay. Everything runs locally against a **local Anvil chain with
valueless test tokens (mUSDC), fictional fixtures, and an admin-controlled mock oracle**. Say this out loud in
the first 15 seconds of the demo.

## 1. Start (pick ONE — they use the same ports)

**Docker (recommended for recording — production web build):**

```bash
docker compose down -v          # full reset: fresh chain + empty database
docker compose up --build       # wait for "fairplay-setup exited with code 0", then open the app
```

**Local toolchain:**

```bash
pnpm install
pnpm demo:setup                 # creates .env if missing, restarts the local chain, deploys, seeds, indexes
scripts/stack.sh start          # API :4600 + web :3600 (logs: .fairplay/api.log, .fairplay/web.log)
```

> ⚠ With Docker, always reset with `docker compose down -v` before `up`. Re-running only `docker compose up`
> re-deploys the contracts while the already-running API keeps the old addresses.

## 2. Pre-flight (2 minutes, before you hit record)

- [ ] http://localhost:3600 shows **8 events** and the hero says **Reconciled**.
- [ ] No events named "E2E …" or "ADM…/WAL…" are visible. If there are, the test suites ran against this
      stack: reset (section 1).
- [ ] Header shows a live block number (green dot).
- [ ] `pnpm demo:flow` was **not** run on this state (it consumes the Team Alpha "Total maps" market). If it
      was, reset.
- [ ] Browser zoom 100%, window ≈1440×900, dark OS theme, notifications muted.
- [ ] Optional rehearsal on a scratch reset: `pnpm demo:flow` (expect "Demo workflow complete"), then reset again.

## 3. The 3-minute script

| Time | Step | Do | Expected on screen |
|---|---|---|---|
| 0:00 | **1. Open the sportsbook** | Landing page; click *Esports*, then *All sports*; type "lakers" in search, clear it | Hero "Bet Transparently. Verify Everything."; live escrow stats; "Demo data" badges; featured odds tick (a pending move shows as `→ x.xx`) |
| 0:20 | **2. Connect the dev wallet** | *Connect wallet* → **Anvil dev · Demo bettor** | Header shows `0x90…b906` and an mUSDC balance |
| 0:30 | **3. Obtain mock USDC** | *Get test mUSDC* | Toast "Received 1,000 mUSDC (testnet)" with a block number; balance increases |
| 0:40 | **4. Place a bet** | Open **Team Alpha vs Team Omega** → *Total maps* → **Over 2.5** → stake **50** → *Approve 50 mUSDC* → *Place bet* | Slip shows *odds shown* vs *executable on-chain now* (2.2500), fee 2% of winnings, net payout **111.25**, max loss 50. Then "Bet #N confirmed on-chain" with locked odds and payout from the `BetPlaced` event |
| 1:05 | **5. Inspect the transaction** | Click the tx hash | Status *Success*, `BettingMarket.placeBet`, decoded `BetPlaced` + `Transfer`, confirmations, gas |
| 1:20 | **6. Open the admin console** | *Connect wallet* → switch to **Anvil dev · Admin (dev)** → *Admin* → *Sign in* | Badge with the admin address and its on-chain roles; metrics tiles; market table |
| 1:35 | **7. Resolve via the mock oracle** | Row *Team Alpha … Total maps* → *Close* → *Resolve* → **Over 2.5** → *Sign & publish result* | Toast "Result published to the mock oracle"; row shows "result: Over 2.5 (dispute window)", then **Settled** within ~15 s (keeper) |
| 2:05 | **8. Claim the payout (and the refund)** | Switch back to **Demo bettor** → *My Bets* → *Claim payout*; on *Nebula Five vs Iron Lotus* → *Claim refund* | "verified on-chain" on each row; toast "Claim confirmed on-chain"; rows become *Paid out* (111.25) and *Refunded* (75.00) |
| 2:30 | **9. Verify final contract state** | *Transparency* | "Fully collateralised" (held = owed), "Matches chain", settlement records incl. this market with result source + timestamp; read the **Trust assumptions** box |
| 3:00 | Close | — | "Local test-token demo, fictional fixtures, admin-controlled mock oracle; production roadmap in the docs." |

## 4. Reset

| Situation | Command |
|---|---|
| Docker | `docker compose down -v && docker compose up --build` |
| Local | `pnpm demo:setup` (restarts the chain it started, redeploys, truncates and re-indexes the database), then `scripts/stack.sh restart` |
| After running the e2e suites or `pnpm demo:flow` | reset as above — those create extra fixtures |

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not reach the FairPlay API" | Docker: `docker compose logs api`. Local: `scripts/stack.sh status`, `.fairplay/api.log` |
| Port 8565/5482/4600/3600 in use | The other stack is running: `docker compose down` or `scripts/stack.sh stop` |
| Odds shown ≠ executable | Expected for a moment while a simulated move is pending; the slip always locks the executable price |
| Bet fails with "The odds changed…" | A simulated move confirmed first; click *Place bet* again (nothing was charged) |
| Faucet says "Faucet in 59m" | One drip per hour per wallet. The demo bettor's seeded refund still demonstrates a claim |
| Market stays "awaiting result" | Keeper runs every 3 s after the 10 s dispute window; check `api` logs; admin row also has *Settle* |
| "Wrong network" | Choose an *Anvil dev* wallet, or switch the browser wallet to chain 31337 |

## 6. Wallet setup notes

**Anvil dev wallet (default):** no extension, no key in the browser. The local node signs for its unlocked
development accounts. Shown only when the app targets chain 31337.

**MetaMask (manual check — not automated):**
1. Add network: RPC `http://127.0.0.1:8565`, chain id `31337`, symbol ETH.
2. Import an Anvil account (e.g. account #5, a public dev key printed by `anvil`) — **never a real key**.
3. *Connect wallet* → *Browser Wallet*. Run: connect, switch network away and back ("Wrong network"
   appears), sign-in rejection on /admin, place a bet, reject a transaction, disconnect.
The injected-wallet code path these steps use is covered by the simulated-provider e2e suite
(`apps/web/e2e/wallet-injected.spec.ts`), but a real extension has not been tested.

**WalletConnect:** requires a project id from https://cloud.reown.com. Set
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env` (local) or as a build arg / GitHub Actions secret, then
rebuild the web app. Without it the WalletConnect option is hidden (tested). Not tested with a real mobile
wallet.

## 7. Known limitations (state them if asked)

- Results come from an **admin-controlled mock oracle** — the contract checks who reported and when, not truth.
- Odds movement is a **simulated** random walk; fixtures are **fictional**; mUSDC has **no value**.
- **No external audit.** Fuzz/invariant tests and one Slither pass only.
- A market manager can cancel (refund) a market until a valid result is final — documented trust assumption.
- No KYC/AML, geo-restriction or responsible-gambling controls. Local chain only; not deployed to a testnet (a Sepolia procedure exists and was rehearsed on a local fork — docs/SEPOLIA_DEPLOYMENT.md).
- Single API instance; no load testing; mobile checked in a headless browser at phone width, not on devices.
- MetaMask and WalletConnect have not been tested with real wallets (see section 6).
