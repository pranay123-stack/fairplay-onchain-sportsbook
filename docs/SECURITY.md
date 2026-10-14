# Security

> **No external audit has been performed.** This document is the author's own review. It lists what is
> enforced, what is assumed, and the known weaknesses. Testnet tokens only: nothing here holds value.

## Trust assumptions

| Component | Trusted for | If it misbehaves |
|---|---|---|
| **Mock oracle reporter key** | Reporting *true* sporting results | It can report a false winner. The contract only checks *who* reported (REPORTER_ROLE), *when* (after close), and enforces a dispute window during which `DISPUTER_ROLE` can correct it. **Nothing makes the result true.** |
| **Market manager** (admin + operator service) | Creating honest markets and cancelling only when warranted | It can cancel a market that has not yet received a settleable final result, for example during the dispute window after an unfavourable result. Cancellation refunds stakes, so the manager cannot take bettors' money, but it can void a bet the house was about to lose. This is visible on-chain (`MarketCancelled` with a reason). |
| **Odds manager** (operator service) | Sensible prices | It can set any odds in `[1.01, 100]`. The house's exposure is bounded by each market's `maxLiability` and by the global reservation check. Bettors are protected from *price changes* by `expectedOdds`. |
| **Liquidity manager** (deployer) | Funding the house | It can withdraw only *free* liquidity. Capital backing open liabilities cannot be moved. |
| **Pauser** | Emergencies | It can stop new bets and settlement, but **cannot** block claims of settled markets or refunds. |
| **Backend API** | Metadata (team names, rules text), the indexed read model, convenience | It **cannot** change bet ownership, odds locked into a bet, settlement or payouts. Those live in the contract. A tampered database is detected by reconciliation (tested) and repaired by a rebuild from the raw log. |
| **Frontend** | Displaying data | Payout values are never sent from the frontend. The contract computes them. The bet slip shows the contract's own `quote()`. |

**"Provably fair" — precise meaning in this MVP.** *Transparent on-chain settlement*: escrow, odds locking,
collateralisation and payout maths are enforced by code anyone can inspect and replay. *Cryptographically
verifiable randomness* (e.g. VRF) is a different property that sports betting does not use. *Trustworthy
real-world results* need a trustworthy oracle, which **this demo does not have**: results are
admin-attested. The UI says so on every market and on the Transparency page.

## Contract-level controls

See [SMART_CONTRACTS.md](SMART_CONTRACTS.md#security-properties) for the property-to-test table. In brief:
`ReentrancyGuard` on every function that moves tokens or settles, checks-effects-interactions, `SafeERC20`,
balance-delta checks on inbound transfers, `AccessControl` with separated roles, a strict market state
machine, a liability reservation check before every bet, withdrawals limited to free liquidity, a
single-claim flag, an oracle allow-list bound per market, a dispute window, and rejection of results that
predate the close.

### Static analysis — Slither (run on `src/`, informational/optimisation excluded)

18 results, none High or Medium. Triage:

| Detector | Count | Verdict |
|---|---|---|
| `timestamp` | 15 | **Accepted by design.** Kick-off, close and dispute windows are time-based. Validators can skew timestamps by seconds, which is immaterial against kick-off times measured in hours. A production system should still close markets *before* kick-off (see "past-posting"). |
| `uninitialized-local` | 2 | **False positive.** `maxGross` and `refund` intentionally start at their zero values. |
| `incorrect-equality` | 1 | **Benign.** `last == 0` in `MockUSDC.faucetAvailableIn` is a "never used the faucet" sentinel. |

## Review findings (pre-demo review, 2026-10-14)

Self-review of the implemented contracts. Severity uses the usual audit scale. These are **not** audit
results.

| ID | Severity | Component | Finding | Status / remediation |
|---|---|---|---|---|
| F-1 | Low | `BettingMarket.settleMarket` | `questionId` is predictable (`keccak256(chainId, contract, marketId)`). A reporter could file a *cancellation* for a market that did not exist yet; once created, anyone could void it via `settleMarket`. Refunds only, so no fund loss, but a griefing / DoS vector. | **Fixed.** Markets record `createdAt`; oracle cancellations reported before it are rejected (`ResultPredatesMarket`). Regression: `test_F1_preReportedCancellation_cannotVoidFutureMarket`. The manager can still cancel deliberately. |
| F-2 | Medium (trust) | `cancelMarket` | The market manager can void a market during the oracle dispute window, e.g. after an unfavourable result. | **Accepted for the MVP**, documented. Remediation: timelock/multisig on cancellation, published policy, monitoring. |
| F-3 | Medium (economic) | `setOdds` / mempool | Odds-latency arbitrage: a pending `setOdds` is visible before it is mined. | **Accepted**, documented below. Remediation: suspend around updates, private submission, signed quotes. |
| F-4 | Info | `MockOracleAdapter.correctResult` | Each correction restarts the dispute window, so the disputer can delay settlement indefinitely. | **Accepted** (mock oracle). Remediation: cap corrections / bonded disputes in a real adapter. |
| F-5 | Info | `setOracleAllowed` | Removing an adapter from the allow-list does not affect markets already bound to it. | By design (binding is immutable); documented. |
| F-6 | Low (UX) | Web bet slip | A bet that was mined but reverted (price moved after the wallet estimated gas) showed only "transaction reverted". | **Fixed.** The slip replays the call at the pre-block state and shows the contract's reason (e.g. "The odds changed…"). Covered by `wallet-injected.spec.ts`. |

Boundary behaviour verified by new regression tests (`test/Review.t.sol`): corrections inside the window
settle to the corrected result (or refund on a corrected cancellation); only `DISPUTER_ROLE` corrects;
settle/cancel are exactly complementary at `finalAt − 1` / `finalAt`; many winners claiming in any order
drain `outstandingClaims` to zero and repeat or foreign claims fail; multiple bets on one outcome at
different locked odds reserve `ΣG − S`; pause blocks settlement and unpause recovers it; oracle outcome
indices above 15 are rejected; many micro-bets round in the house's favour (fuzzed).

## Known weaknesses and residual risks

1. **Oracle trust** (above). This is the dominant risk and only an independent oracle with economic
   disputes can address it. See the roadmap.
2. **Manager can void unfavourable markets** before a result becomes settleable (above). Mitigations for
   production: a timelock or multisig on `cancelMarket`, published cancellation policy, and monitoring.
3. **Odds latency arbitrage.** A `setOdds` transaction is visible in the public mempool before it is mined.
   A bettor can race it at the old price. `expectedOdds` protects *bettors* from price changes, not the house
   from stale prices. Production mitigations: suspend the market (`closeMarket` → `reopenMarket`) around
   updates, private transaction submission for odds updates, minimum bet delay, or signed off-chain quotes
   with short expiry.
4. **Past-posting.** Betting stays open until `closeTime = startTime`. If a real event started early, or
   information leaked before the scheduled start, late bets could be informed. The operator must set
   start times conservatively and close markets early when needed.
5. **Single liquidity pool.** All markets share one house balance. A correlated set of outcomes could
   exhaust free liquidity; new bets are then rejected (never accepted unbacked).
6. **Admin key custody.** Locally every key is a public Anvil key. In production, `DEFAULT_ADMIN_ROLE` should
   sit behind a multisig plus timelock, and service keys in a KMS/HSM with narrowly scoped roles (already
   separated: the operator cannot touch liquidity or fees).
7. **No upgradeability.** The contracts are immutable. Fixing a bug means redeploying and migrating. Claims on
   the old contract keep working because claims are never paused.
8. **Unbounded arrays in views.** `getBetIds(bettor)` returns every id. It is fine for a view function but
   not for on-chain consumers.

## API and backend controls

| Control | Implementation |
|---|---|
| Wallet-signature login | SIWE-style message with domain, address, chain id, nonce, issue and expiry times ([`auth-service.ts`](../apps/api/src/auth/auth-service.ts)) |
| Nonce expiry | `AUTH_NONCE_TTL_SECONDS` (default 300s) |
| Replay protection | the server stores each nonce and its exact message; consumption is atomic (`UPDATE … WHERE usedAt IS NULL`), so concurrent replays race and exactly one wins (tested with 5 parallel replays) |
| Smart-contract wallets | `publicClient.verifyMessage` (EIP-1271 / EIP-6492 aware) |
| Sessions | random 256-bit bearer token; only its SHA-256 is stored; 1h TTL; revocable (logout) |
| **Authorisation** | every admin request re-reads `hasRole` on the contract (5s cache). Revoking a role on-chain locks out a live session (tested). API authentication never substitutes for the contract's own role checks on the service keys. |
| High-impact actions | resolve and cancel require a **fresh, single-use wallet signature over their exact parameters**. The server rebuilds the message from the request, so a signature for "outcome 0" cannot resolve "outcome 2" (tested). |
| Validation | Zod schemas on every body, query and param; amounts and odds are parsed without floating point |
| Errors | structured `{ error: { code, message, details } }`; contract reverts are surfaced by name (`CHAIN_REJECTED` + `reason`) |
| Rate limiting | global per-IP limit plus a tighter limit on `/api/auth/*` (in-memory, per instance) |
| CORS | allow-list of web origins (tested: other origins get 403) |
| Headers | `@fastify/helmet` |
| Logging | Pino structured logs; the authorization header and signatures are redacted |
| Audit trail | every admin action (OK / FAILED / DENIED) in `AdminAuditLog`; every backend transaction in `Transaction` |
| Key safety | API and deploy script refuse public Anvil keys on any chain other than 31337 |

**Known backend gaps:** in-memory rate limiting does not survive restarts or span replicas (use Redis). The
admin session token lives in `sessionStorage`, so an XSS bug would expose it; production needs a strict CSP
or httpOnly cookies with CSRF protection. The keeper and odds engine assume a single API instance (they share
one nonce-ordered sender per key).

## Indexer integrity

The database is a **read model**. Raw logs are stored with `(txHash, logIndex)` uniqueness, so
reprocessing is idempotent. Aggregates are recomputed from bet rows, never incremented. Stored block hashes
detect reorganisations, after which everything above the common ancestor is dropped and rebuilt. A periodic
reconciliation compares every market, outcome and bet field with contract state **at the indexed block**
and reports mismatches on the Transparency page. All of this is covered by integration tests against a real
Anvil, including a real `evm_revert`-driven reorg.

## Supply-chain notes

* `.npmrc` sets `ignore-scripts=true`, so no third-party install scripts run.
* Solidity libraries (`forge-std v1.11.0`, `openzeppelin-contracts v5.4.0`) are vendored from the official
  tagged GitHub release tarballs into `packages/contracts/lib`.
* Two optional modules pulled in transitively by RainbowKit's wallet list (`@coinbase/cdp-sdk`, which FairPlay
  never calls) are aliased to a stub that **throws** if ever invoked ([`optional-dep-stub.ts`](../apps/web/lib/optional-dep-stub.ts)).
