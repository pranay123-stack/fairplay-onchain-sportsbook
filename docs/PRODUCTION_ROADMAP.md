# Production roadmap

FairPlay is a **demonstration MVP**. This document is the gap list between it and anything that could take
real money. Items are ordered roughly by when they block launch.

## MVP limitations (as built)

| Area | Limitation |
|---|---|
| Money | Valueless `MockUSDC` only. No real-money flows, fiat ramps or withdrawals to banks. |
| Results | Admin-attested **mock oracle**. Results are not independently verified. |
| Odds | A **simulated** random walk. No trading desk, risk engine or external price feed. |
| Fixtures | Fictional demo data. Real club names appear only as clearly-labelled fictional fixtures. |
| Compliance | None: no KYC/AML, sanctions screening, geofencing or responsible-gambling controls. |
| Audit | No external audit. One Slither pass, fuzz and invariant tests. |
| Scale | Single API instance (keeper, odds engine and nonce-ordered senders assume one); polling indexer; in-memory rate limits. |
| Contracts | Immutable, single collateral, single liquidity pool, operator-managed markets. |
| Deployment | Local Anvil only; Sepolia is configured but has not been deployed. |

## 1. External contract audit
* Freeze the contract scope and write a specification from `docs/SMART_CONTRACTS.md`.
* Two independent audits plus a public contest; fix and re-audit; publish the reports.
* Formal verification of invariants I1–I4 (e.g. Certora/Halmos), branch coverage → ~100%.
* A bug bounty proportional to TVL before any public launch.

## 2. Licensed betting operations
* Legal entity and licence in each target jurisdiction (e.g. Malta MGA, Isle of Man, Curaçao's new regime).
  Licence terms dictate much of what follows: fund segregation, audited RNG/odds systems, reporting.
* Licensed operators must control who can bet: the permissionless contract needs an eligibility gate
  (signed allow-list or attestation per wallet) wired to the compliance stack.
* Terms and conditions, market rules and dispute policy written by counsel and published.

## 3. KYC / AML and sanctions
* KYC provider integration with tiered limits. Bind verified identities to wallets through signed,
  expiring attestations checked by `placeBet`.
* On-chain sanctions screening of deposit and withdrawal addresses, plus transaction monitoring for
  structuring, chip-dumping between accounts, and mixer exposure.
* Travel-rule and record-keeping obligations for the chosen jurisdictions.

## 4. Responsible gambling
* Deposit, loss and stake limits per user (enforced by the eligibility attestation and by the contract).
* Self-exclusion and cool-off periods honoured across all wallets bound to an identity.
* Reality checks, spend history and affordability checks where required. No incentives to chase losses.

## 5. Independent outcome oracles
* Replace `MockOracleAdapter` with adapters that implement the same `IOracleAdapter`:
  * **Optimistic oracle** (UMA-style): anyone proposes a result with a bond, anyone can dispute within a
    window, and disputes escalate to a token-holder vote. Matches the existing `finalAt` semantics.
  * **Licensed sports-data feeds** delivered via Chainlink Functions or a dedicated node network, ideally an
    m-of-n quorum of independent providers.
* Per-market choice of adapter, already supported, with conservative defaults.

## 6. Oracle disputes
* Bonded disputes with slashing, longer windows for large markets, and an emergency "freeze settlement"
  path that is itself timelocked and transparent.
* A public dispute log and an SLA for resolution. The settlement UI should show dispute status, not just
  `finalAt`.

## 7. Operational monitoring
* Alerts on: reconciliation mismatch, indexer lag beyond the confirmation depth, reserved liquidity
  above a threshold of house capital, unusual bet patterns, oracle reports deviating from secondary
  sources, failed or stuck service transactions, and pause events.
* Dashboards (Prometheus/Grafana or a hosted equivalent), structured log shipping, on-call runbooks.
* Shared rate limiting and sessions (Redis); horizontal API scaling with a single elected
  indexer/keeper leader.

## 8. Chain reorganisations
* Per-chain confirmation depth (the MVP supports it; set it from chain finality guarantees, e.g.
  "finalized" tags on Ethereum L1 and the L2 equivalents).
* Keep the replayable raw-log design. Consider a dedicated indexer (Ponder, Subsquid, The Graph) once volume
  needs it.
* Reorg tests already exist; add chaos tests against a forked network.

## 9. Contract upgrade governance
* Decide between immutable plus migration (current) and upgradeable proxies with a timelock. Either way,
  claims must stay available on old deployments.
* `DEFAULT_ADMIN_ROLE` behind a multisig and timelock. Service keys in KMS/HSM with the minimum roles (already
  split: operator ≠ liquidity ≠ treasury).
* Time-locked parameter changes (fee caps, oracle allow-list) with on-chain announcements.

## 10. Treasury risk management
* A real trading/risk desk: price feeds, margin, per-market and per-event (correlated) exposure limits,
  dynamic `maxLiability`.
* Mitigate odds-latency arbitrage: suspend markets during updates, private transaction submission, or
  signed off-chain quotes with short TTL verified on-chain.
* Liquidity provider design (if external LPs): share accounting, withdrawal queues, and loss
  socialisation rules; separate fee and LP capital (the MVP already separates them).
* Stablecoin choice and depeg handling; multi-collateral if needed.

## 11. Geographic restrictions
* Geofencing at the edge (IP plus device signals) **and** in the eligibility attestation, since the contract
  is reachable directly.
* A per-jurisdiction product matrix: which sports and market types are allowed, limits and tax handling.

## 12. Product and engineering hardening
* Gas optimisation (packing `Bet`, cheaper id lists) and an L2 deployment for low fees.
* Strict CSP and httpOnly session cookies for the admin console; separate admin origin.
* Accessibility audit, internationalisation, and full mobile QA on real devices.
* Load tests of the API, indexer and Socket.IO fan-out.
