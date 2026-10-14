# Architecture

## Principles

1. **The contracts are the source of truth** for balances, bets, odds locked into bets, settlement and payouts.
2. **The database is a read model plus metadata store.** It is rebuilt from contract events, and nothing
   written to it can change who owns a bet or how it settles.
3. **The frontend never supplies payout values.** It shows the contract's `quote()`, sends `expectedOdds`, and
   reads the locked values back from the `BetPlaced` event in the receipt.
4. **No private keys in the frontend.** Browser wallets sign. Locally, the "Anvil dev wallet" connector
   forwards to the node, which signs with its unlocked development accounts.
5. **API authentication never substitutes for on-chain authorisation.** Admin requests re-check `hasRole`.
   The keys that actually send admin transactions are themselves role-gated by the contract.
6. **Integer arithmetic only** for anything financial (contract, shared TS library, UI).

## Components

```
                         ┌────────────────────────── Browser ───────────────────────────┐
                         │ Next.js 16 · React 19 · wagmi/viem · RainbowKit · TanStack Q │
                         │  reads: API (lists, history) + contract (quote, betStatus,   │
                         │         balances)        writes: wallet → contract           │
                         └───────┬──────────────────────────────┬──────────────────────┘
                     REST + Socket.IO                     JSON-RPC (wallet / reads)
                                 │                              │
┌────────────────────────────────▼───────────────┐   ┌──────────▼──────────────────────┐
│ API (Node 22 · Fastify 5 · Zod · Pino)          │   │ EVM chain (Anvil local / Sepolia)│
│  routes: public · auth (SIWE-style) · admin     │   │  BettingMarket                   │
│  MarketService ── operator key ────────────────────▶│  MockOracleAdapter               │
│                └─ oracle reporter key ─────────────▶│  MockUSDC                        │
│  Indexer (poll, confirmations, reorgs) ◀───────────── logs                            │
│  Reconciler (DB vs contract @ indexed block)    │   └──────────────────────────────────┘
│  Keeper (close at kick-off, settle when final)  │
│  Simulated odds engine (random walk → setOdds)  │
│  Socket.IO broadcaster                          │
└──────────────┬──────────────────────────────────┘
               │ Prisma 7 (driver adapter)
        ┌──────▼──────┐
        │ PostgreSQL  │  metadata · read model · raw ChainLog · auth nonces · sessions · audit log
        └─────────────┘
```

### Monorepo

```
fairplay/
  apps/web/               Next.js frontend (+ Playwright e2e in apps/web/e2e)
  apps/api/               Fastify API, indexer, keeper, odds engine (+ vitest integration tests)
  packages/contracts/     Foundry project (src, test, script, vendored lib/)
  packages/shared/        ABIs (generated), integer odds maths, Zod schemas, DTO types, constants
  infrastructure/docker/  app image, Postgres init
  scripts/                demo-setup.ts, demo-flow.ts, stack.sh
  docs/
```

## Key flows

### Placing a bet

1. The user clicks an outcome. The slip records the **displayed** odds (from the read model).
2. The slip calls `BettingMarket.quote(market, outcome, stake)` every 1.5s. This is the **executable**
   price, the gross, fee and net amounts, and whether the contract would accept the bet. If displayed ≠
   executable the slip says so. A pending odds update is shown but marked "not executable yet".
3. If needed the user approves exactly the stake amount (`approve`), then sends
   `placeBet(market, outcome, stake, expectedOdds = quote.odds)`.
4. The UI waits for the receipt and decodes `BetPlaced`. The confirmation screen shows the **locked odds,
   payout, bet id and block taken from the event**, never computed locally.
5. The indexer picks the event up after the confirmation depth and broadcasts `bet:confirmed`. My Bets then
   shows it, and also re-verifies each bet's status by calling `betStatus()` directly.

### Odds updates (simulated)

The odds engine picks an eligible market every 10–20 s. Eligible means `simulateOdds = true`, open, more
than 90 s before kick-off, and no pending update. It applies a random walk to implied probabilities at a
fixed 105% overround, writes an `OddsHistory` row as **PENDING**, broadcasts `odds:pending`, and sends
`setOdds` with the operator key. The row is linked to its transaction hash at broadcast. Only when the
indexer sees `OddsUpdated` does the row become **CONFIRMED** (`odds:updated`); only then are the new odds
what `quote()` returns. Accepted bets keep their locked odds. There is no external sports feed, and every
UI surface labels the odds history "Simulated".

### Resolving and settling

1. The admin closes the market (operator key) or kick-off passes, after which the keeper closes it.
2. The admin picks a winner and **signs a single-use challenge over `{winningOutcome, source}`**. The API
   verifies it, then the **oracle reporter key** calls `MockOracleAdapter.reportResult`.
3. After the dispute window (`ORACLE_FINALITY_SECONDS`, 10 s locally) the keeper calls the permissionless
   `settleMarket`, which anyone could call; the admin UI has a "Settle" button too.
4. Winners `claim`. Cancelled markets refund via the same `claim`.

### Indexing

* Poll `eth_getLogs` for both contracts from `lastBlock + 1` to `head − INDEXER_CONFIRMATIONS`, in batches.
* Fetch the header of every block that has logs, plus the batch tip. A log whose block hash no longer
  matches its header means the chain moved, so the tick retries.
* In **one DB transaction**: insert raw `ChainLog` rows (unique `(txHash, logIndex)`; existing rows are
  skipped), apply projections, recompute aggregates for touched markets from bet rows, store block hashes,
  and advance `lastBlock`. Progress and data commit atomically, so a crash can neither skip nor duplicate.
* **Reorg:** each tick compares the stored tip hash with the chain. On mismatch it walks the stored hashes
  back to the common ancestor, deletes logs and blocks above it, resets every chain-derived column, replays
  `ChainLog` in order, and broadcasts `chain:reorg`. A restarted local Anvil (same addresses, different chain)
  takes the same path. A changed deployment address wipes chain data and re-indexes.
* **Reconciliation** runs every 30 s and compares every market, outcome and bet with
  `readContract(…, blockNumber = lastIndexed)`. Comparing at the same block means indexing lag never shows up
  as a false mismatch.

### Metadata linking

Team names, rules and market titles live off-chain. Each event and market row gets a UUID, and its
on-chain `ref` is `keccak256("fairplay:<kind>:<uuid>")`. That ref is passed to `createEvent`/`createMarket`
and emitted in the event, which is how the indexer joins chain data to metadata. Objects created on-chain
without metadata (e.g. via `cast`) are indexed as "Unlabelled on-chain event #n" rather than hidden.

## Real-time events (Socket.IO)

`event:created`, `market:created`, `market:status` (open/close/settle/cancel), `odds:pending`,
`odds:updated`, `bet:confirmed`, `result:reported`, `market:settled`, `market:cancelled`, `payout:claimed`,
`chain:head`, `chain:reorg`. Clients may join a wallet room (`subscribe:wallet`) to receive `wallet:*`
copies of their own bet and payout events. Payloads are notifications only: clients refetch from the API.

## Data model (Prisma)

| Model | Kind | Notes |
|---|---|---|
| `Event`, `Market`, `Outcome` | metadata + projection | `[meta]` and `[chain]` columns are marked in `schema.prisma` |
| `BetIndex` | projection | one row per on-chain bet |
| `OddsHistory` | projection + pending proposals | PENDING → CONFIRMED / FAILED |
| `Settlement`, `OracleReport` | projection | from `MarketSettled`/`MarketCancelled` and `ResultReported` |
| `ChainLog`, `IndexedBlock`, `IndexerState` | indexer internals | raw decoded logs are the replay source |
| `Transaction` | backend tx log | every transaction the operator/oracle services sent, with outcome |
| `User` | projection | first/last seen bettor addresses |
| `AuthNonce`, `AdminSession`, `AdminAuditLog` | auth | single-use nonces, hashed session tokens, every admin action |

## Ports (local)

| Service | Port |
|---|---|
| Anvil | 8565 |
| PostgreSQL | 5482 |
| API | 4600 |
| Web | 3600 |

## Technology choices

* **Fastify + Zod.** Schema validation on every route, fast and small. Zod schemas are shared with the
  frontend through `@fairplay/shared`.
* **Prisma 7 with the `pg` driver adapter.** Typed queries, migrations, and no Rust query engine.
* **viem everywhere.** The same ABIs (generated `as const` from forge output) give end-to-end typed calls in
  the API, scripts and wagmi hooks.
* **Polling indexer instead of a hosted indexer.** No paid services; explicit control over confirmations,
  reorgs and reconciliation.
* **One serialised sender per backend key.** The odds engine, keeper and admin actions share keys without
  nonce collisions, and every send is simulated first so reverts surface by name before broadcast.
