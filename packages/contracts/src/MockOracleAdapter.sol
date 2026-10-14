// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";

/// @title MockOracleAdapter — an ADMIN-ATTESTED result source for local demonstration.
/// @notice This is NOT a decentralized oracle. Results are whatever an account holding REPORTER_ROLE says
///         they are. What it does provide:
///           * only REPORTER_ROLE can publish (enforced on-chain, not by the API);
///           * every report is a public, timestamped event naming the reporter and a source string;
///           * a finality window during which DISPUTER_ROLE can correct a report before settlement can
///             consume it — the same shape an optimistic-dispute oracle would have;
///           * once final, a result can never be changed.
contract MockOracleAdapter is IOracleAdapter, AccessControl {
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant DISPUTER_ROLE = keccak256("DISPUTER_ROLE");

    uint8 public constant MAX_OUTCOME_INDEX = 15;

    /// @notice Seconds a report must stand before it is final.
    uint64 public finalityDelay;

    mapping(bytes32 => OracleResult) private _results;

    event ResultReported(
        bytes32 indexed questionId,
        ResultStatus status,
        uint8 winningOutcome,
        address indexed reporter,
        uint64 reportedAt,
        uint64 finalAt,
        string source
    );
    event ResultCorrected(bytes32 indexed questionId, ResultStatus status, uint8 winningOutcome, address indexed disputer);
    event FinalityDelaySet(uint64 delay);

    error AlreadyReported(bytes32 questionId);
    error NotReported(bytes32 questionId);
    error AlreadyFinal(bytes32 questionId);
    error InvalidOutcome(uint8 outcome);
    error EmptySource();

    constructor(address admin, uint64 finalityDelay_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DISPUTER_ROLE, admin);
        finalityDelay = finalityDelay_;
        emit FinalityDelaySet(finalityDelay_);
    }

    function setFinalityDelay(uint64 delay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        finalityDelay = delay;
        emit FinalityDelaySet(delay);
    }

    /// @notice Publish the winning outcome index for a question.
    function reportResult(bytes32 questionId, uint8 winningOutcome, string calldata source)
        external
        onlyRole(REPORTER_ROLE)
    {
        if (winningOutcome > MAX_OUTCOME_INDEX) revert InvalidOutcome(winningOutcome);
        _report(questionId, ResultStatus.Resolved, winningOutcome, source);
    }

    /// @notice Publish that the fixture was abandoned/voided; markets on it refund all stakes.
    function reportCancellation(bytes32 questionId, string calldata source) external onlyRole(REPORTER_ROLE) {
        _report(questionId, ResultStatus.Cancelled, 0, source);
    }

    /// @notice Correct a report while it is still inside its finality window. Restarts the window.
    function correctResult(bytes32 questionId, ResultStatus status, uint8 winningOutcome)
        external
        onlyRole(DISPUTER_ROLE)
    {
        OracleResult storage r = _results[questionId];
        if (r.status == ResultStatus.None) revert NotReported(questionId);
        if (block.timestamp >= r.finalAt) revert AlreadyFinal(questionId);
        if (status == ResultStatus.None) revert InvalidOutcome(winningOutcome);
        if (winningOutcome > MAX_OUTCOME_INDEX) revert InvalidOutcome(winningOutcome);
        r.status = status;
        r.winningOutcome = status == ResultStatus.Resolved ? winningOutcome : 0;
        r.reportedAt = uint64(block.timestamp);
        r.finalAt = uint64(block.timestamp) + finalityDelay;
        r.reporter = msg.sender;
        emit ResultCorrected(questionId, status, r.winningOutcome, msg.sender);
        emit ResultReported(questionId, status, r.winningOutcome, msg.sender, r.reportedAt, r.finalAt, r.source);
    }

    function getResult(bytes32 questionId) external view returns (OracleResult memory) {
        return _results[questionId];
    }

    function isFinal(bytes32 questionId) external view returns (bool) {
        OracleResult storage r = _results[questionId];
        return r.status != ResultStatus.None && block.timestamp >= r.finalAt;
    }

    function _report(bytes32 questionId, ResultStatus status, uint8 winningOutcome, string calldata source) private {
        if (_results[questionId].status != ResultStatus.None) revert AlreadyReported(questionId);
        if (bytes(source).length == 0) revert EmptySource();
        uint64 nowTs = uint64(block.timestamp);
        _results[questionId] = OracleResult({
            status: status,
            winningOutcome: winningOutcome,
            reportedAt: nowTs,
            finalAt: nowTs + finalityDelay,
            reporter: msg.sender,
            source: source
        });
        emit ResultReported(questionId, status, winningOutcome, msg.sender, nowTs, nowTs + finalityDelay, source);
    }
}
