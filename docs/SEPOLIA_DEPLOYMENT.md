# Sepolia testnet deployment

> **Status: NOT deployed to Sepolia.** The procedure below has been rehearsed end-to-end on a **local fork of
> Sepolia** (real chain id 11155111 and real Sepolia state, every transaction kept local). It has **not** been run
> against the live Sepolia network. Do not describe FairPlay as "live on Sepolia" until section 4 has been run
> and its end-to-end checks have passed.

Sepolia is a public **test** network: its ETH and FairPlay's mUSDC have no value. The local Anvil demo is
unchanged and remains the default (`pnpm demo:setup`, `docker compose up`).

## 0. What changes on Sepolia

| | Local Anvil (default) | Sepolia |
|---|---|---|
| Wallet | "Anvil dev wallet" (node signs) or browser wallet | **Real browser wallet only** (MetaMask / injected; WalletConnect if configured). The development wallet is not offered and its factory throws off the local chain. |
| Keys | Anvil's public dev keys | **Fresh keys you generate.** The API, deploy script and preflight refuse all 10 Anvil dev accounts. |
| Deployer key | env var | **Encrypted Foundry keystore** (`--account`), never in a file |
| Oracle | Mock, admin-controlled | **Same mock, admin-controlled oracle.** No real oracle is integrated. |
| Odds engine | On (simulated moves) | **Off by default** (it would spend test ETH every 10–20 s) |
| Indexer | 1 confirmation, 1 s poll | 3 confirmations, 6 s poll, 500-block log batches (public-RPC friendly) |
| Database | `fairplay` | Separate `fairplay_sepolia` |
| Explorer links | none (in-app viewer) | `https://sepolia.etherscan.io` plus the in-app viewer |
| Faucet | MockUSDC faucet | Same MockUSDC faucet (1,000 mUSDC/hour/wallet, 10k balance cap); **test ETH from a public faucet** |

## 1. Prerequisites (you must provide these)

1. **Three fresh accounts, used only for this testnet demo.** Never reuse a key that holds real funds, and never
   use an Anvil key.
   - **Deployer**: becomes DEFAULT_ADMIN, LIQUIDITY_MANAGER, TREASURY, PAUSER and MARKET_MANAGER. Keep it in an encrypted keystore.
   - **Operator** (backend hot key): MARKET_MANAGER + ODDS_MANAGER. Creates and opens markets, closes them, settles.
   - **Oracle reporter** (backend hot key): REPORTER_ROLE on the **mock, admin-controlled** oracle.

   ```bash
   cast wallet new --number 3            # prints 3 fresh address/key pairs — store them securely, never in git
   cast wallet import fairplay-deployer --interactive   # paste the deployer key; choose a password
   ```

2. **Sepolia test ETH** for each account. Preflight computes the requirement from the **live gas price** using
   measured budgets: deployment ≈ 8.7M gas, operator ≈ 12M gas (~40 transactions), reporter ≈ 2M gas, all with 3×
   headroom. At today's typical Sepolia gas price the floors apply (0.005 / 0.003 / 0.001 ETH). Faucets (terms and
   availability change, so check each site): Google Cloud Web3 faucet (Ethereum Sepolia), the Alchemy and Infura
   Sepolia faucets (some require a small mainnet balance), and the proof-of-work faucet at `sepolia-faucet.pk910.de`.
   Send to the deployer first, then transfer small amounts to the operator and reporter.
3. **A Sepolia RPC URL for the backend.** A keyed provider (Alchemy, Infura, …) is recommended. It stays
   server-side (`RPC_URL`) and is never sent to browsers. Keep it out of git.
4. **A public, key-less RPC for the browser** (`NEXT_PUBLIC_RPC_URL`), e.g.
   `https://ethereum-sepolia-rpc.publicnode.com`. Anything in `NEXT_PUBLIC_*` ships to every visitor. Preflight
   fails if this looks like a keyed URL.
5. Optional: an **Etherscan API key** (source verification) and a **WalletConnect project id** (section 7).
6. **MetaMask** (or another injected wallet) with Sepolia enabled, for the bettor and the admin.
7. PostgreSQL from this repo: `docker compose up -d postgres`.

## 2. Configure

```bash
cp .env.sepolia.example .env.sepolia     # git-ignored; fill every <placeholder>
chmod 600 .env.sepolia
```

Required values: `RPC_URL`, `DEPLOYER_KEYSTORE_ACCOUNT` (e.g. `fairplay-deployer`), `DEPLOYER_ADDRESS`,
`OPERATOR_PRIVATE_KEY`, `ORACLE_REPORTER_PRIVATE_KEY`. Contract parameters: `FEE_BPS` (default 2%),
`ORACLE_FINALITY_SECONDS` (dispute window; 120 suggested), `HOUSE_LIQUIDITY` (whole mUSDC minted and deposited
during deployment; 50,000 suggested).

## 3. Read-only checks (no transactions)

```bash
pnpm sepolia preflight    # config, keys (fresh/distinct/not Anvil), RPC chain id, live gas → balances, git-ignore, DB
pnpm sepolia db           # creates + migrates fairplay_sepolia (local database only)
pnpm sepolia deploy       # SIMULATION: runs the whole deployment against a fork of your RPC, prints gas; writes nothing
```

## 4. Deploy (broadcasts — needs your explicit go-ahead)

```bash
pnpm sepolia deploy --broadcast    # asks for the keystore password, then for the deployer address as confirmation
pnpm sepolia verify                # read-only: code at each address, addresses match forge receipts, roles,
                                   # allow-list, 6 decimals, collateral, dispute window, solvency, deploy block
pnpm sepolia seed                  # simulation: prints the 3 fictional fixtures it would create
pnpm sepolia seed --broadcast      # ~9 operator transactions; confirms with the deployer address
```

What `deploy --broadcast` does in one script: deploys MockUSDC, MockOracleAdapter and BettingMarket; grants
operator MARKET_MANAGER + ODDS_MANAGER and reporter REPORTER; allow-lists the oracle; mints `HOUSE_LIQUIDITY` to the
deployer and deposits it; asserts all of that on-chain; writes `packages/contracts/deployments/11155111.json` (only
when broadcasting; a simulation never writes it); and verifies source on Etherscan when `ETHERSCAN_API_KEY` is
set. Before broadcasting, the script refuses Anvil accounts, duplicate roles and an unfunded deployer.

## 5. Run the app on Sepolia

```bash
FAIRPLAY_ENV_FILE=.env.sepolia scripts/stack.sh start    # API (+ indexer, keeper; odds engine off) and web
# → http://localhost:3600 shows the "Sepolia testnet" badge
```

Do not run the local Docker stack at the same time: both use ports 3600/4600. Stop them with
`scripts/stack.sh stop` / `docker compose down`.

**Admin account.** Admin login needs MARKET_MANAGER_ROLE or DEFAULT_ADMIN_ROLE on BettingMarket. Rather than
importing the deployer into MetaMask, grant the role to a separate admin wallet you control:

```bash
cast send <BettingMarket> "grantRole(bytes32,address)" $(cast keccak MARKET_MANAGER_ROLE) <your-admin-wallet> \
  --account fairplay-deployer --rpc-url "$RPC_URL"
```

## 6. End-to-end check on Sepolia (do this before claiming "works on Sepolia")

With MetaMask on Sepolia, using a bettor wallet (not a role holder):

| # | Step | Expected |
|---|---|---|
| 1 | Open the app | Badge "Sepolia testnet"; connect dialog shows **no** "Anvil dev" wallets |
| 2 | Connect MetaMask while it is on another network | App asks to switch to Sepolia; "Wrong network" if you decline |
| 3 | Get test mUSDC | `faucet()` transaction; balance +1,000 after confirmation |
| 4 | Bet on a seeded market | Approve, then place; "Confirm in wallet…" while pending; then "Bet #N confirmed" with locked odds |
| 5 | Open the transaction | In-app viewer shows Success and decoded `BetPlaced`; the Etherscan link resolves |
| 6 | Reject a signature/transaction in MetaMask | Clear "rejected" error; nothing placed |
| 7 | Admin wallet → /admin → Sign in | Session with on-chain roles |
| 8 | Close → Resolve (sign) | Result reported by the **mock, admin-controlled** oracle; settles after `ORACLE_FINALITY_SECONDS` + keeper interval (~2–3 min) |
| 9 | Bettor → My Bets → Claim | Payout transaction; row "Paid out"; Transparency shows held ≥ owed and "Matches chain" |

Record the transaction hashes. Only after all nine pass is "verified on Sepolia" accurate.

## 7. WalletConnect

Without `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, only injected browser wallets are offered (tested). To enable
WalletConnect and RainbowKit's MetaMask entry:

1. Create a free project at https://cloud.reown.com and copy the project id.
2. Add your app origin (e.g. `http://localhost:3600`) to the project's allowed domains.
3. Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<id>` in `.env.sepolia` and restart the web app. In CI, provide it as
   a GitHub Actions secret, not in a file.

The project id is not secret, but treat it as configuration and keep it out of git. **WalletConnect has not been
tested with a real mobile wallet.**

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Preflight: "public Anvil development account" | You used an Anvil key. Generate fresh keys (`cast wallet new`) |
| Preflight: balance FAIL | Fund from a faucet; the requirement scales with the live gas price |
| Preflight: "KEYED RPC URL" | `NEXT_PUBLIC_RPC_URL` must be a public key-less endpoint |
| `deploy --broadcast` refuses non-interactively | Run it in a terminal, or set `FAIRPLAY_CONFIRM_BROADCAST=<deployer address>` deliberately |
| API exits "Deployment file is for chain …" | `DEPLOYMENT_FILE` points at the wrong file; Sepolia uses `deployments/11155111.json` |
| Indexer lag / RPC 429s | Raise `INDEXER_POLL_MS`, lower `INDEXER_BATCH_BLOCKS` (e.g. 200), use a keyed backend RPC |
| Market not settling | Dispute window (`ORACLE_FINALITY_SECONDS`) + keeper interval (15 s) + 3 confirmations; the admin row also has *Settle* |
| Odds never move | Expected: the simulated odds engine is off on Sepolia. Use *Edit odds* / *Simulate* in the admin console (each costs gas) |
| "Wrong network" in the header | Switch MetaMask to Sepolia (the app only transacts on 11155111) |

## 9. How this was rehearsed (no live Sepolia)

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --port 8566 --block-time 2   # local Sepolia fork
# .env.sepolia-fork.local (git-ignored): RPC 127.0.0.1:8566, 3 freshly generated keys funded with anvil_setBalance,
# DB fairplay_sepolia_fork, ports 4610/3610
FAIRPLAY_ENV_FILE=.env.sepolia-fork.local pnpm sepolia preflight | db | deploy | deploy --broadcast | verify | seed --broadcast
FAIRPLAY_ENV_FILE=.env.sepolia-fork.local scripts/stack.sh start
E2E_NETWORK=sepolia-fork E2E_BASE_URL=http://localhost:3610 E2E_API_URL=http://127.0.0.1:4610 \
  E2E_RPC_URL=http://127.0.0.1:8566 E2E_ADMIN_KEY=<rehearsal deployer key> pnpm test:e2e
```

Rehearsal results: preflight, the simulation (8,668,176 gas, nothing written), the broadcast gate (refused without
or with a wrong confirmation), deployment, all 17 verification checks, seeding with reconciliation OK, and 6/6
browser tests (`apps/web/e2e/sepolia-fork.spec.ts`). Those tests cover: no development wallet; network switching;
signature rejection; faucet, approve and bet with pending → confirmed and transaction rejection; indexer and
reconciliation; and the admin close → signed resolve → keeper settle → UI claim lifecycle. The browser wallet in
those tests is a **simulated EIP-1193 provider**, not MetaMask.
