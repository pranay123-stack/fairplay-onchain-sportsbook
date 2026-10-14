# Demo guide — the 3-minute walkthrough

Everything below happens on a **local chain with valueless test tokens**. The fixtures are fictional and the
results are admin-attested by a mock oracle. The app says so on every page.

## 0. Before the call (≈2 minutes, once)

**Option A — Docker (one command):**

```bash
docker compose up --build        # chain → deploy + seed + index → API → web
```

**Option B — local toolchain** (Node 22, pnpm 9, Foundry, Docker for Postgres):

```bash
pnpm install
pnpm env:init          # creates .env for the local chain
pnpm demo:setup                  # starts Anvil, Postgres, deploys, seeds, indexes (~1 min)
scripts/stack.sh start           # API (+ indexer, keeper, odds engine) and web
```

Open **http://localhost:3600**. To rehearse unattended, run `pnpm demo:flow`: it executes all nine steps
against the running stack and verifies each one on-chain (about 20 seconds).

> Reset before a live demo: `pnpm demo:setup` (local) or `docker compose down -v && docker compose up --build`
> (Docker). Do not just re-run `docker compose up`: it redeploys while the running API keeps the old addresses.

**Wallet.** No browser extension is needed. In the connect dialog choose **"Anvil dev · Demo bettor"** or
**"Anvil dev · Admin (dev)"**. The local node holds those development accounts and signs for them; the page
never sees a private key. MetaMask also works if you import an Anvil account and add network
`http://127.0.0.1:8565`, chain id `31337`.

## The walkthrough

| # | Do | Point out |
|---|---|---|
| 1 | **Explore events.** Landing page → filter Football / Basketball / Esports, search "lakers". | "Demo data" badges. Live escrow and "Reconciled" stats in the hero come from the contract. Odds on featured markets move every 10–20 s via the **simulated** engine; a pending move shows as "→ x.xx" until it is mined. |
| 2 | **Connect wallet.** Connect wallet → *Anvil dev · Demo bettor*. | The header shows the mUSDC balance read from the token contract. |
| 3 | **Obtain mock USDC.** Click **Get test mUSDC**. | A real `faucet()` transaction: rate-limited, valueless. |
| 4 | **Place a bet.** Open *Team Alpha vs Team Omega* → *Total maps → Over 2.5* → stake 50 → Approve → **Place bet**. | The slip separates *odds shown* from *executable on-chain now* (the contract's `quote()`), and shows the gross payout, the 2% fee on winnings, the net payout and the maximum loss. The confirmation shows **locked odds and payout read from the `BetPlaced` event**. |
| 5 | **Inspect the transaction.** Click the tx hash. | The in-app explorer decodes the receipt from the node: `placeBet()`, `BetPlaced`, the mUSDC `Transfer`, confirmations and gas. |
| 6 | **Open the admin panel.** Switch wallet to *Anvil dev · Admin (dev)* → **Admin** → **Sign in**. | A wallet signature over a single-use, expiring nonce. The API re-checks the admin's **on-chain role** on every request. |
| 7 | **Resolve the event.** Markets tab → that market → **Close** → **Resolve** → pick *Over 2.5* → **Sign & publish result**. | A second signature covers *exactly this action*. The result goes through the **mock oracle reporter** key: the contract checks who reported and that it was after close. Within ~10 s (the dispute window) the keeper calls the permissionless `settleMarket`, and the row flips to *Settled*. |
| 8 | **Claim payout.** Switch back to *Demo bettor* → **My Bets** → **Claim payout**. Also **Claim refund** on *Nebula Five vs Iron Lotus* (a seeded cancelled fixture). | Each row says "verified on-chain": its status comes from `betStatus()`, not just the database. The payout equals the amount locked at bet time. |
| 9 | **Verify final records.** **Transparency** page. | Tokens held = tokens owed (`solvency()`); reserved liability vs free liquidity; settlement records with result source and timestamp; the contract event feed; copy-paste `cast` commands; and the **trust assumptions**, stated plainly. |

## Talking points (if asked)

* **Why this is solvent:** every bet reserves the market's worst-case house loss `max(0, maxᵢ Gᵢ − S)` before
  it is accepted. Withdrawals can only touch unreserved capital. An invariant test settles every market at
  its worst outcome from random states and pays every claim. See [SMART_CONTRACTS.md](SMART_CONTRACTS.md).
* **What "provably fair" does and doesn't mean here:** settlement is transparent and deterministic; the
  sporting result is not independently verified. See [SECURITY.md](SECURITY.md#trust-assumptions).
* **What stops stale odds:** `placeBet` takes `expectedOdds` and reverts with `OddsChanged` if the price moved.
* **What if the DB is wrong:** reconciliation compares it with the contract at the indexed block and the
  Transparency page shows any mismatch. The integration tests tamper with a row and watch it get caught and
  repaired.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not reach the FairPlay API" | `scripts/stack.sh status`; logs in `.fairplay/api.log` |
| Port already in use (8565/5482/4600/3600) | Another FairPlay stack is running (Docker *or* local, not both): `docker compose down` or `scripts/stack.sh stop` |
| Wallet shows "Wrong network" | Choose an *Anvil dev* wallet, or switch MetaMask to chain 31337 |
| Faucet button says "Faucet in 59m" | One drip per hour per wallet; the demo bettor can still claim its seeded refund |
| Data looks stale after restarting Anvil | Local: `pnpm demo:setup`. Docker: `docker compose down -v && docker compose up --build` |
