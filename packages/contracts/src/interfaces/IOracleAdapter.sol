// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOracleAdapter — the only path by which a real-world outcome reaches BettingMarket.
/// @notice The interface is deliberately source-agnostic so the MVP's MockOracleAdapter can later be
///         replaced by an adapter for an optimistic-dispute oracle (e.g. UMA-style), a Chainlink-compatible
///         sports feed, or a quorum of independent data providers — without changing BettingMarket.
///
///         IMPORTANT: an adapter only moves a *claim* about a sporting result on-chain. Whether that claim is
///         true depends entirely on who is allowed to report it. See docs/SECURITY.md (trust assumptions).
interface IOracleAdapter {
    enum ResultStatus {
        None, // nothing reported
        Resolved, // a winning outcome was reported
        Cancelled // the fixture was abandoned / voided — all stakes are refunded
    }

    struct OracleResult {
        ResultStatus status;
        uint8 winningOutcome; // valid only when status == Resolved
        uint64 reportedAt; // block timestamp of the (latest) report
        uint64 finalAt; // earliest timestamp at which the result may be consumed (dispute window end)
        address reporter; // account that reported it
        string source; // human-readable provenance, e.g. "FairPlay mock oracle (admin-attested)"
    }

    /// @notice Latest result for `questionId` (status None if nothing has been reported).
    function getResult(bytes32 questionId) external view returns (OracleResult memory);

    /// @notice True once a result exists and its dispute/finality window has elapsed.
    function isFinal(bytes32 questionId) external view returns (bool);
}
