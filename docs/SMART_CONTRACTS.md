# Smart contracts

Solidity `0.8.28` (pragma `^0.8.24`), Foundry, OpenZeppelin Contracts `v5.4.0`. Source in
[`packages/contracts/src`](../packages/contracts/src).

| Contract | Purpose |
|---|---|
| [`BettingMarket.sol`](../packages/contracts/src/BettingMarket.sol) | Events, fixed-odds markets, escrow, liability reservation, settlement, claims, house liquidity, fees |
| [`interfaces/IOracleAdapter.sol`](../packages/contracts/src/interfaces/IOracleAdapter.sol) | The only path by which a sporting result reaches a market |
| [`MockOracleAdapter.sol`](../packages/contracts/src/MockOracleAdapter.sol) | Admin-attested result source for the demo (reporter role + dispute window) |
| [`mocks/MockUSDC.sol`](../packages/contracts/src/mocks/MockUSDC.sol) | 6-decimal valueless test token with a rate-limited faucet |
| [`script/Deploy.s.sol`](../packages/contracts/script/Deploy.s.sol) | Deploys all three, wires roles, asserts the wiring on-chain, writes `deployments/<chainId>.json` |

## Units and arithmetic

* **Amounts:** mUSDC base units, 6 decimals (`1 mUSDC = 1_000_000`).
* **Odds:** fixed point with `ODDS_SCALE = 1e4`. `2.50` is `25_000`. Allowed range: `1.01` (`10_100`) to
  `100.00` (`1_000_000`).
* **Fees:** basis points on *winnings* (profit), capped at `MAX_FEE_BPS = 1_000` (10%). The rate is
  snapshotted into each market when it is created, so a later fee change never touches existing markets.
* **No floating point.** Every division rounds down, which always favours the contract's solvency:

```
gross  = floor(stake × odds / 10_000)
profit = gross − stake
fee    = floor(profit × feeBps / 10_000)
net    = gross − fee          // Bet.potentialPayout — what the bettor receives if the outcome wins
```

The TypeScript `computePayout` in [`packages/shared/src/odds.ts`](../packages/shared/src/odds.ts) mirrors
this exactly. An API integration test compares the two on 300 random vectors against the deployed contract,
and the UI's displayed payout comes from the contract's own `quote()` view.

## Market lifecycle

```
            openMarket            closeMarket / kick-off            settleMarket (final oracle winner)
  Pending ─────────────▶ Open ─────────────────────────▶ Closed ───────────────────────────────▶ Settled
     │                    │ ▲          reopenMarket          │
     │                    │ └──────── (manager, before ──────┘
     │                    │           kick-off, no result)
     └────────────────────┴──────────────────┬───────────────┘
                 cancelMarket (manager)       │  or settleMarket with a final oracle CANCELLATION
                                              ▼
                                          Cancelled  (every stake refundable)
```

| Transition | Who | Conditions |
|---|---|---|
| `createEvent` | `MARKET_MANAGER_ROLE` | start time in the future |
| `createMarket` → Pending | `MARKET_MANAGER_ROLE` | event exists and has not started; 2–8 outcomes; odds in range; oracle on the allow-list |
| `openMarket` | `MARKET_MANAGER_ROLE` | Pending, before kick-off |
| `closeMarket` | manager any time; **anyone** after kick-off | Open. `closedAt = min(now, closeTime)` |
| `reopenMarket` | `MARKET_MANAGER_ROLE` | Closed, before kick-off, oracle has reported nothing |
| `setOdds` | `ODDS_MANAGER_ROLE` | Pending/Open. Affects new bets only and bumps `oddsVersion` |
| `settleMarket` | **anyone** | see below |
| `cancelMarket` | `MARKET_MANAGER_ROLE` | not Settled or Cancelled, and no result that `settleMarket` would accept |

`settleMarket` accepts a result only if all of the following hold:

1. The result comes from the adapter **bound to the market at creation**. Only allow-listed adapters can be
   bound, and an adapter cannot be swapped afterwards.
2. The adapter says the result is **final**, meaning its dispute window has passed.
3. For a winner: the market is closed (implicitly closed if kick-off has passed), the result was reported **at
   or after** the close (a result that predates kick-off is rejected as pre-arranged), and the winning index is
   in range.
4. A final **cancellation** is accepted at any stage, because refunds benefit no one.

Settlement is O(1) per market. Winners are not iterated; each claims individually (`claim`, `claimMany`).
Losing bets need no transaction: their stakes move to the house inside the aggregate settlement, and
`betStatus()` reports them as `Lost`.

## The liquidity model (why every accepted bet can be paid)

The house (liquidity provider) is the counterparty to every bet and pre-funds `houseBalance`.

For a market with total stake `S` and, per outcome `i`, gross payout `Gᵢ = Σ floor(stakeⱼ × oddsⱼ / 1e4)`:

* If outcome `i` wins, the house receives every losing stake and pays every winner's gross profit:
  `houseDelta = (S − stakeᵢ) − (Gᵢ − stakeᵢ) = S − Gᵢ`.
* The worst case for the house is therefore `Rₘ = max(0, maxᵢ Gᵢ − S)`. Losing stakes in the same market net
  against winners, because a market settles atomically to exactly one outcome or refunds everything.
* `totalReserved = Σ Rₘ` over unsettled markets.

`placeBet` computes the market's new `Rₘ'` **before any external call** and requires both:

```
Rₘ' ≤ market.maxLiability                               // per-market risk cap
totalReserved − Rₘ + Rₘ' ≤ houseBalance                 // global coverage
```

A bet on the underdog can *lower* `Rₘ`. A perfectly balanced book reserves nothing; this is tested.

`withdrawLiquidity` can only take `houseBalance − totalReserved`.

**Accounting buckets.** Every token the contract holds belongs to exactly one bucket:

| Bucket | Increases | Decreases |
|---|---|---|
| `houseBalance` | deposits; `S − G_w` at settlement if positive | withdrawals; `G_w − S` at settlement if positive |
| `openStake` | each bet's stake | `S` at settlement/cancellation |
| `outstandingClaims` | Σ net payout of winners at settlement; `S` at cancellation | each claim |
| `accruedFees` | `G_w − N_w` at settlement | treasury withdrawals |

### Invariants (enforced in code, tested by the invariant suite)

| # | Invariant |
|---|---|
| I1 | `collateral.balanceOf(this) ≥ houseBalance + openStake + outstandingClaims + accruedFees` (equality unless someone donates tokens) |
| I2 | `houseBalance ≥ totalReserved` |
| I3 | Every market's stored `reserved` equals `max(0, maxᵢ Gᵢ − S)` recomputed from its books; `totalReserved` and `openStake` equal their sums; `outstandingClaims` equals the sum over bets of `Won ⇒ potentialPayout` plus `Refundable ⇒ stake` |
| I4 | **Worst case is always payable.** From any reachable state, settling *every* live market at its worst outcome for the house and then claiming *every* claimable bet succeeds without a revert and leaves I1 intact |

**Proof sketch for settlement.** Before settling market `m`: `H ≥ totalReserved ≥ Rₘ ≥ G_w − S`. After it:
`H' = H + S − G_w ≥ H − Rₘ ≥ totalReserved − Rₘ = totalReserved'`. So I2 is preserved and `H'` cannot
underflow. Bucket conservation holds because the four deltas `(−S) + (N_w) + (G_w − N_w) + (S − G_w)` sum
to zero.

## Bet record

```solidity
struct Bet {
    uint256 id;
    address bettor;
    uint256 marketId;
    uint256 outcomeId;
    uint256 stake;
    uint256 odds;            // locked at placement — later odds moves never change it
    uint256 potentialPayout; // net of fee
    bool claimed;
}
```

`placeBet(marketId, outcomeId, stake, expectedOdds)` reverts with `OddsChanged(expected, current)` unless
the executable odds equal what the bettor saw, which is the stale-odds protection.

## Security properties

| Property | Mechanism | Tests |
|---|---|---|
| No reentrancy | `ReentrancyGuard` on every function that moves tokens or settles (`placeBet`, `settleMarket`, `claim`, `claimMany`, deposit/withdraw, fee withdrawal), checks-effects-interactions, `SafeERC20` | `Reentrancy.t.sol` (ERC-777-style callback token) |
| Exact transfers | `_pull` checks the balance delta and rejects fee-on-transfer/rebasing collateral | — |
| No double claim | `claimed` flag is set before the transfer; `betStatus` returns `Claimed` | `test_doubleClaim_reverts` |
| Only the bettor claims | `NotBettor` | `test_onlyBettorCanClaim` |
| No bet after close | status check + `block.timestamp < closeTime` even if nobody called `closeMarket` | `test_betAfterKickoff_*` |
| No unauthorised result | reporter role on the adapter; adapter allow-list; adapter bound per market | `test_unauthorized*`, `test_settle_ignoresResultsFromAnotherOracle` |
| No pre-arranged result | `ResultPredatesClose` | `test_resultReportedBeforeClose_isRejected` |
| Final valid results are honoured | `cancelMarket` refuses once `settleMarket` would accept a winner | `test_cannotCancelAfterFinalResolvedResult` |
| No market can lock funds forever | any result that cannot settle leaves the market cancellable | `test_regression_prematureFinalResult_doesNotLockStakes`, `test_oracle_outOfRangeWinner_*`, invariant I4 |
| Exits are never paused | `pause()` stops new bets, deposits and settlement — never `claim`/`claimMany` | `test_pause_blocksNewRisk_butNeverClaims` |

## Roles

| Role | Holder (local demo) | Can do |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | deployer (Anvil #0) | grant/revoke roles, allow-list oracle adapters, set fee for future markets |
| `MARKET_MANAGER_ROLE` | deployer, operator service (Anvil #1) | create events/markets, open/close/reopen, cancel |
| `ODDS_MANAGER_ROLE` | operator service | `setOdds` |
| `LIQUIDITY_MANAGER_ROLE` | deployer | deposit/withdraw house liquidity (never reserved capital) |
| `TREASURY_ROLE` | deployer | withdraw accrued fees |
| `PAUSER_ROLE` | deployer | pause/unpause new risk |
| `REPORTER_ROLE` (adapter) | oracle reporter service (Anvil #2) | report a result or a cancellation |
| `DISPUTER_ROLE` (adapter) | deployer | correct a report inside its dispute window |

The operator key **cannot** withdraw house liquidity or fees. The keys that can are held by the deployer.

## Tests

```bash
cd packages/contracts
forge test                         # 66 tests: unit, fuzz, reentrancy, review regressions, deploy-script guards, invariants
FOUNDRY_PROFILE=ci forge test      # deeper fuzzing (5,000 runs) and invariants (512 × 256)
forge coverage --ir-minimum --no-match-contract SolvencyInvariant --report summary
```

| Suite | Count | What it covers |
|---|---|---|
| `BettingMarket.t.sol` | 41 | the 16 required scenarios and more: placement, win, loss, refund, unauthorised settlement, double claim, liquidity, closure, stale odds, solvency, state machine, multiple bettors, shared collateral, precision, fees, pause, oracle window, faucet, regression |
| `Fuzz.t.sol` | 4 | payout maths; any accepted bet is payable whichever outcome wins; random multi-bettor books settle with `houseDelta = S − G_w`; withdrawals never touch reserves |
| `Reentrancy.t.sol` | 1 | an ERC-777-style collateral re-enters `claim` from its transfer hook and is blocked |
| `Review.t.sol` | 10 | pre-demo review: F-1 regression, correction window, finality boundary, concurrent claims, same-outcome reservation, pause recovery, oracle index bound, rounding fuzz |
| `DeployScript.t.sol` | 6 | the real deploy script on a public chain id: refuses Anvil accounts for every role, duplicate roles and an unfunded deployer; wires roles and liquidity with fresh accounts |
| `invariant/Solvency.invariant.t.sol` | 4 | I1–I4 above, driven by a 14-action handler (create, odds, bet, close, honest and bad oracle reports, settle, cancel, claim, deposit, withdraw, fees, donation, time warp) |

**Measured (default profile, Foundry 1.5.1, 2026-10-14):** all 66 pass. The invariant campaign runs 256 runs × 128
depth = 32,768 calls per invariant. Across the campaign the handler logs about 1,900 accepted bets, 3,600
settled markets, 700 voided markets and 300 claims; `cache/invariant-stats.csv` records per-run activity,
because forge prints only the last run.
**Coverage of `BettingMarket.sol`:** 96% lines, 91% statements, 95% functions, **68% branches**. Most
uncovered branches are `require`-style guards with no dedicated negative test.

### Bugs found during development and review

1. **Market locked forever by an out-of-range winner.** A final oracle result naming a non-existent outcome
   made `settleMarket` revert (`InvalidResult`) *and* `cancelMarket` revert (the result was "final"). Found
   by a unit test.
2. **Market locked forever by a premature winner.** A valid winner reported *before kick-off* that became
   final was rejected by `settleMarket` (`ResultPredatesClose`) and also blocked `cancelMarket`. Found in two
   calls by invariant I4. The fix gates cancellation on "would `settleMarket` accept this?" instead of on
   "is there a final result?".
3. **Pre-filed oracle cancellation (review F-1).** Because question ids are predictable, a cancellation could
   be reported for a market before it existed and then void it later. Markets now record `createdAt` and
   ignore older cancellations.

## Gas (indicative, `forge test` report)

`placeBet` ≈ 380k gas for a market's first bet (cold storage for the bet, the bettor's id list and the
outcome book), with later bets cheaper. `settleMarket` is constant in the number of bets. These numbers are
not optimised; see the production roadmap.

## Sepolia deployment (optional)

Not deployed. Procedure (encrypted keystore, preflight, simulation-by-default, typed confirmation, on-chain
verification) and the local-fork rehearsal results: [SEPOLIA_DEPLOYMENT.md](SEPOLIA_DEPLOYMENT.md).
