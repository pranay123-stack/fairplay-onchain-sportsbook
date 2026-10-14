<div align="center">

# FairPlay

### Transparent, fully-collateralised sports betting on Ethereum

**Every bet, every locked price, every payout is an on-chain record that anyone can verify.**

[![CI](https://github.com/pranay123-stack/fairplay-onchain-sportsbook/actions/workflows/ci.yml/badge.svg)](https://github.com/pranay123-stack/fairplay-onchain-sportsbook/actions/workflows/ci.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.28-363636?logo=solidity)
![Foundry](https://img.shields.io/badge/Foundry-66%20tests-orange)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript)
![Playwright](https://img.shields.io/badge/Playwright-25%20E2E-2EAD33?logo=playwright)

![FairPlay sportsbook](docs/images/home.png)

</div>

> **What this is — stated plainly.** FairPlay is a working **demonstration MVP** that runs on a **local Ethereum
> chain (Anvil) with valueless test tokens (mUSDC)**, **fictional fixtures**, and an **admin-controlled mock
> oracle**. It is not real-money gambling, has **not been externally audited**, and is **not deployed to a public
> network** (a Sepolia deployment path is built and rehearsed on a local Sepolia fork — see
> [SEPOLIA_DEPLOYMENT.md](docs/SEPOLIA_DEPLOYMENT.md)).

---

## Why it matters

Traditional sportsbooks ask users to trust a private ledger: you cannot see whether the house can actually pay
every winner, whether your odds were honoured, or how a market was settled. FairPlay moves those guarantees into
code:

| Problem in a traditional book | How FairPlay handles it |
|---|---|
| "Can the house pay if everyone wins?" | Every bet **reserves the house's worst-case loss before it is accepted**; reserved capital can never be withdrawn. Solvency is a public view function. |
| "Did I get the price I clicked?" | Odds are **locked into the bet on-chain**; a stale price makes the transaction revert instead of filling worse. |
| "Who decided the result, and when?" | Results arrive only through a **role-gated oracle adapter**, after betting closed, with a **dispute window** — every report is a public event with reporter and timestamp. |
| "Was my payout calculated correctly?" | Integer-only maths in the contract; the UI shows values **decoded from the transaction receipt**, never computed by the page. |
| "Is the website showing the truth?" | The database is a **rebuildable read model**, continuously **reconciled against the contracts** and re-indexed after chain reorganisations. |

## Highlights

- **Solvent-by-construction fixed-odds engine** — per-market worst-case reservation `max(0, maxᵢ Gᵢ − S)` with
  cross-outcome netting, a global coverage invariant, and fuzz/invariant tests that settle *every* market at its
  worst outcome from random states and pay *every* claim.
- **Security review that found real bugs** — the invariant suite caught two fund-lock bugs and a review found a
  pre-filed-oracle griefing vector; all fixed with regression tests ([findings](docs/SECURITY.md)).
- **Production-style indexer** — confirmation depth, idempotent raw-log store, crash-safe resume, **reorg
  detection and rebuild** (tested with a real chain reorg), field-by-field reconciliation.
- **Wallet-native admin security** — SIWE-style sign-in with single-use expiring nonces, **on-chain role
  re-checked on every request**, and per-action signatures for resolving and cancelling markets.
- **Real-time UX** — Socket.IO pushes odds (pending → confirmed), bets, oracle results, settlements and payouts.
- **Verified with real MetaMask** — faucet, exact-amount approval, bet placement, rejection handling and
  on-chain verification, with transaction hashes below.

---

## System architecture

```mermaid
flowchart LR
    subgraph Browser["Browser — Next.js 16 · React 19"]
        UI["Sportsbook · Bet slip · My Bets<br/>Transparency · Admin console"]
        W["Wallet<br/>MetaMask / injected / dev wallet"]
    end

    subgraph Backend["API — Node 22 · Fastify · Zod · Pino"]
        R["REST routes<br/>public · auth · admin"]
        AUTH["SIWE auth<br/>+ live on-chain role check"]
        SVC["Market service<br/>operator key"]
        ORC["Mock oracle service<br/>reporter key"]
        IDX["Indexer<br/>confirmations · reorgs"]
        REC["Reconciler"]
        KEEP["Keeper<br/>close · settle"]
        WS["Socket.IO"]
    end

    subgraph Chain["Ethereum — Anvil local · Sepolia-ready"]
        BM["BettingMarket<br/>escrow · odds · liability · claims"]
        OA["MockOracleAdapter<br/>reporter role · dispute window"]
        TK["MockUSDC<br/>6-decimal test token"]
    end

    DB[("PostgreSQL<br/>read model · raw logs · audit log")]

    UI -- "REST / WebSocket" --> R
    WS -. "live events" .-> UI
    W -- "sign & send tx · quote() · betStatus()" --> BM
    W --> TK
    R --> AUTH --> SVC
    AUTH --> ORC
    SVC -- "create · open · close · setOdds" --> BM
    ORC -- "reportResult" --> OA
    KEEP -- "settleMarket (permissionless)" --> BM
    BM -- "reads final result" --> OA
    BM -- "logs" --> IDX --> DB
    REC -- "compare at indexed block" --> BM
    REC --> DB
    IDX --> WS
    R --> DB
```

**Trust boundaries:** the contracts hold all value and enforce all money rules. The API holds two role-limited
service keys (it can never move house liquidity or fees). The browser holds no keys at all.

## A bet, end to end

```mermaid
sequenceDiagram
    autonumber
    actor Bettor
    participant UI as Web app
    participant MM as MetaMask
    participant BM as BettingMarket
    participant IDX as Indexer / API
    actor Admin
    participant OR as Mock oracle (admin-controlled)

    Bettor->>UI: select Over 2.5, stake 20
    UI->>BM: quote(market, outcome, 20) → executable price, fee, net
    UI-->>Bettor: shown 1.80 vs executable 1.80, net payout 35.68
    Bettor->>MM: approve exactly 20 mUSDC
    Bettor->>MM: placeBet(…, expectedOdds = 1.80)
    MM->>BM: transaction
    BM->>BM: reserve worst-case liability, lock odds, escrow stake
    BM-->>UI: receipt → BetPlaced(betId 15, odds 1.80, payout 35.68)
    BM-->>IDX: BetPlaced log → read model → WebSocket "bet confirmed"
    Admin->>UI: close market, sign "resolve: Over 2.5"
    UI->>OR: reportResult (reporter key, role-checked on-chain)
    Note over OR: dispute window — result can be corrected, then becomes final
    IDX->>BM: keeper calls settleMarket (anyone may)
    BM->>OR: read final result, reject if reported before close
    Bettor->>BM: claim(15) → 35.68 mUSDC paid from escrow
```

## Market lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending: createMarket
    Pending --> Open: openMarket
    Open --> Closed: closeMarket / kick-off passes
    Closed --> Open: reopenMarket (before kick-off, no result yet)
    Closed --> Settled: settleMarket (final winner, reported after close)
    Pending --> Cancelled: cancelMarket / final oracle cancellation
    Open --> Cancelled: cancelMarket / final oracle cancellation
    Closed --> Cancelled: cancelMarket (until a valid result is final)
    Settled --> [*]: winners claim
    Cancelled --> [*]: everyone refunded
```

## The solvency model

```mermaid
flowchart TB
    B["New bet: stake s on outcome i at odds o"] --> G["Gross payout g = floor(s × o / 10⁴)"]
    G --> R["Market worst case<br/>Rₘ = max(0, maxᵢ Gᵢ − S)<br/>losing stakes net against winners"]
    R --> C1{"Rₘ ≤ market cap?"}
    C1 -- no --> X1["revert MarketLiabilityCapExceeded"]
    C1 -- yes --> C2{"Σ Rₘ ≤ house balance?"}
    C2 -- no --> X2["revert InsufficientLiquidity"]
    C2 -- yes --> OK["Accept: lock odds, escrow stake, reserve Rₘ"]
    OK --> INV["Fuzzed invariants:<br/>tokens held ≥ house + open stakes + owed claims + fees<br/>house balance ≥ total reserved<br/>worst case is always payable"]
```

Full derivation and proof sketch: [SMART_CONTRACTS.md](docs/SMART_CONTRACTS.md).

---

## Proof: real MetaMask, real transactions

Recorded on 2026-10-14 with **MetaMask** (account `0x2420…3F30`) against the local FairPlay chain (chain id 31337,
valueless test tokens). Every row was re-checked against the chain with `cast`.

| Step | Transaction | Block | Result |
|---|---|---|---|
| Faucet — `MockUSDC.faucet()` (+1,000 mUSDC) | `0x819791a87457f8a0f9f5e7ad187e199b5c37c5ae8c97701b7bd85accb4a1b84b` | 10097 | ✅ success · 78,904 gas |
| Approve **exactly** 20 mUSDC (no unlimited allowance) | `0xd7b203431f92d6c98b64d4a765de3eea6144f16ee7be209eb11ee15555497b40` | 10229 | ✅ success · 46,360 gas |
| `placeBet` → **Bet #15**, Over 2.5 at **1.8000**, payout **35.68** | `0xcce1748c402458c6a82a46089d710dda8b539b83bd612f2854b08aa90fe492ba` | 10249 | ✅ success · 296,132 gas |
| Second bet **rejected in MetaMask** | — (nothing broadcast) | — | ✅ app shows "You rejected the request in your wallet" |

On-chain state afterwards: `getBet(15)` → bettor `0x24202245Da80c329682E76EA4282426824C03F30`, stake 20.00,
locked odds 1.8000, potential payout 35.68 (= 36 gross − 2 % fee on the 16 profit); `solvency()` → tokens held
**= tokens owed** = 251,443.60 mUSDC.

| | |
|---|---|
| ![MetaMask faucet request](docs/images/metamask-proof/02-metamask-faucet-request.png)<br/>**1.** MetaMask transaction request for the faucet | ![Faucet confirmed](docs/images/metamask-proof/03-faucet-confirmed.png)<br/>**2.** Confirmed in block 10097; balance read from the chain |
| ![Exact approval](docs/images/metamask-proof/04-metamask-exact-approval.png)<br/>**3.** Spending cap of exactly 20 mUSDC | ![Bet slip](docs/images/metamask-proof/05-bet-slip-executable-odds.png)<br/>**4.** Bet slip: shown vs executable on-chain odds, fee, net payout, max loss |
| ![Bet confirmed](docs/images/metamask-proof/06-bet-confirmed-onchain.png)<br/>**5.** Bet #15 confirmed — values read from the `BetPlaced` event | ![My Bets](docs/images/metamask-proof/07-my-bets-verified-onchain.png)<br/>**6.** My Bets — status re-verified with `betStatus()` |
| ![Rejection](docs/images/metamask-proof/08-wallet-rejection-handled.png)<br/>**7.** Rejected in MetaMask — clear error, nothing sent | ![After](docs/images/metamask-proof/09-sportsbook-after-bet.png)<br/>**8.** Sportsbook afterwards — 15 bets on-chain, read model reconciled |

## More screenshots

| | |
|---|---|
| ![Event](docs/images/event.png) Event detail · simulated odds history · bet history | ![Transparency](docs/images/transparency.png) Transparency · live solvency · trust assumptions |
| ![Admin](docs/images/admin.png) Admin console · signed actions · audit log | ![My Bets](docs/images/my-bets.png) My Bets · claims |

Mobile layout: [docs/images/mobile.png](docs/images/mobile.png). All images are of this application running locally.

---

## Engineering quality

| Suite | Command | Result (2026-10-14) |
|---|---|---|
| Smart contracts — unit, fuzz, reentrancy, review regressions, deploy-script guards, invariants | `cd packages/contracts && forge test` | **66 passed** |
| Smart contracts — deep profile (5,000 fuzz runs; invariants 512 runs × 256 depth) | `FOUNDRY_PROFILE=ci forge test` | **66 passed** |
| API integration — real Anvil + real PostgreSQL (auth, replay, roles, indexer, **reorg**, WebSockets, network config) | `pnpm --filter @fairplay/api test` | **41 passed** |
| Shared integer maths | `pnpm --filter @fairplay/shared test` | **9 passed** |
| Browser E2E — core flow, admin controls, wallet behaviour (Playwright, real chain) | `pnpm test:e2e` | **19 passed** |
| Browser E2E — Sepolia build on a local Sepolia fork | `E2E_NETWORK=sepolia-fork pnpm test:e2e` | **6 passed** (rehearsal) |
| Scripted 3-minute demo, verified on-chain | `pnpm demo:flow` | **9/9 steps** |
| Real MetaMask, manual | see Proof above | ✅ |

- `BettingMarket.sol` coverage: 96 % lines, 68 % branches. Slither: no High/Medium findings ([triage](docs/SECURITY.md)).
- The automated wallet suites use a **clearly-labelled simulated EIP-1193 wallet**; real MetaMask was verified
  manually (above). WalletConnect has not been tested with a real wallet.
- CI ([workflow](.github/workflows/ci.yml)) runs contracts, typecheck + integration tests + web build, and the
  Playwright suite on every push. See the badge at the top for the live status.

## Tech stack

| Layer | Technologies |
|---|---|
| Smart contracts | Solidity 0.8.28 · Foundry · OpenZeppelin 5.4 (AccessControl, ReentrancyGuard, Pausable, SafeERC20) |
| Backend | Node 22 · TypeScript · Fastify 5 · Prisma 7 / PostgreSQL 16 · Socket.IO · Zod · Pino · viem |
| Frontend | Next.js 16 · React 19 · Tailwind 4 · Radix/shadcn-style UI · wagmi 2 · RainbowKit · TanStack Query · Zustand · Recharts · Framer Motion |
| Quality & ops | Vitest · Playwright · Slither · Docker Compose · GitHub Actions |

## Run it yourself

**One command (Docker):**

```bash
docker compose up --build          # → http://localhost:3600
```

**Local toolchain** (Node 22.12+, pnpm 9, Foundry 1.5, Docker for Postgres):

```bash
pnpm install
pnpm env:init                      # .env for the local chain (public Anvil dev keys only)
pnpm demo:setup                    # chain + DB + deploy + seed 8 fictional events + index
scripts/stack.sh start             # API :4600 · web :3600
pnpm demo:flow                     # optional: the 9-step demo, verified on-chain
```

Connect with **"Anvil dev · Demo bettor"** (no extension needed — the local node signs, no key in the browser), or
use MetaMask with network RPC `http://127.0.0.1:8565`, chain id 31337.

| Guide | |
|---|---|
| [DEMO_GUIDE.md](docs/DEMO_GUIDE.md) | 3-minute walkthrough |
| [CLIENT_DEMO_CHECKLIST.md](docs/CLIENT_DEMO_CHECKLIST.md) | pre-recording checklist, reset, troubleshooting |
| [SEPOLIA_DEPLOYMENT.md](docs/SEPOLIA_DEPLOYMENT.md) | testnet deployment procedure (fork-rehearsed) |

## Documentation

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, data flows, indexer design, data model |
| [SMART_CONTRACTS.md](docs/SMART_CONTRACTS.md) | lifecycle, liquidity model & invariants, roles, tests, bugs found |
| [SECURITY.md](docs/SECURITY.md) | trust assumptions, controls, review findings, Slither triage, residual risks |
| [PRODUCTION_ROADMAP.md](docs/PRODUCTION_ROADMAP.md) | audit, licensing, KYC/AML, responsible gambling, oracles, disputes, monitoring, governance |

## Honest limitations

- **Results are trusted, not verified:** the mock oracle is controlled by the operator. The contract enforces
  *who* reported, *when*, and a dispute window — not *truth*. Production needs an independent/optimistic oracle.
- A market manager can cancel (refund) a market until a valid result is final — a documented trust assumption.
- Simulated odds, fictional fixtures, valueless token; no KYC/AML, geo-restriction or responsible-gambling controls.
- No external audit; a single API instance runs the keeper and odds engine; no load testing.
- Not deployed to a public network yet; WalletConnect untested with a real wallet; mobile verified in a headless
  browser, not on devices.

## Repository layout

```
apps/web            Next.js frontend · Playwright suites (apps/web/e2e)
apps/api            Fastify API · indexer · reconciler · keeper · odds engine · Vitest integration tests
packages/contracts  Foundry project — BettingMarket, MockOracleAdapter, MockUSDC, tests, deploy script
packages/shared     generated ABIs · integer odds maths · Zod schemas · DTO types
scripts             env-init · demo-setup · demo-flow · sepolia · stack.sh
docs                architecture · contracts · security · guides · roadmap · screenshots
```

## Keys and secrets

No real secrets are in this repository. `.env.example` and `.env.sepolia.example` contain placeholders; the only
keys present (`.env.docker`, tests, scripts) are **Anvil's publicly-known development keys**, which the deploy
script, API and Sepolia preflight refuse on any network other than the local chain.

---

<div align="center">
<sub>Built by <a href="https://github.com/pranay123-stack">pranay123-stack</a> · Solidity libraries vendored from official tagged releases (forge-std v1.11.0, OpenZeppelin v5.4.0) · third-party install scripts disabled</sub>
</div>
