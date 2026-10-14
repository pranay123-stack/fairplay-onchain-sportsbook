// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {BettingMarket} from "../src/BettingMarket.sol";
import {MockOracleAdapter} from "../src/MockOracleAdapter.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// Findings from the pre-demo security review (see docs/SECURITY.md "Review findings").
contract ReviewTest is BaseTest {
    /// F-1: a cancellation filed for a market id that does not exist yet must not be able to void that
    /// market once it is created and has bets.
    function test_F1_preReportedCancellation_cannotVoidFutureMarket() public {
        uint256 nextId = book.marketCount() + 1;
        bytes32 predicted = keccak256(abi.encode(block.chainid, address(book), nextId));
        vm.prank(reporter);
        oracle.reportCancellation(predicted, "filed before the market existed");
        vm.warp(block.timestamp + FINALITY);

        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 100e6);
        vm.expectRevert(
            abi.encodeWithSelector(BettingMarket.ResultPredatesMarket.selector, uint64(1_800_000_000), uint64(block.timestamp))
        );
        book.settleMarket(m); // must NOT cancel the market
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Open));
        // The manager can still void it deliberately; the market is never stuck.
        vm.prank(manager);
        book.cancelMarket(m, "stale oracle entry");
        vm.prank(alice);
        assertEq(book.claim(1), 100e6);
    }

    function _closedWithResult(uint8 winner) internal returns (uint256 m, bytes32 q) {
        m = _defaultMarket();
        _bet(alice, m, 0, 100e6);
        _bet(bob, m, 1, 100e6);
        BettingMarket.Market memory mk = book.getMarket(m);
        q = mk.questionId;
        vm.warp(mk.closeTime + 1);
        vm.prank(reporter);
        oracle.reportResult(q, winner, "test");
    }

    // ── correction window ────────────────────────────────────────────────────────────────

    function test_correctionWithinWindow_settlesToCorrectedWinner() public {
        (uint256 m, bytes32 q) = _closedWithResult(0);
        vm.warp(block.timestamp + FINALITY / 2);
        vm.prank(admin);
        oracle.correctResult(q, IOracleAdapter.ResultStatus.Resolved, 1);
        // The original window has passed, but the correction restarted it.
        vm.warp(block.timestamp + FINALITY / 2 + 1);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultNotFinal.selector, q));
        book.settleMarket(m);
        vm.warp(block.timestamp + FINALITY);
        book.settleMarket(m);
        assertEq(book.getMarket(m).winningOutcome, 1);
        assertEq(uint8(book.betStatus(1)), uint8(BettingMarket.BetStatus.Lost));
        assertEq(uint8(book.betStatus(2)), uint8(BettingMarket.BetStatus.Won));
    }

    function test_correctionToCancellation_refundsEveryone() public {
        (uint256 m, bytes32 q) = _closedWithResult(0);
        vm.prank(admin);
        oracle.correctResult(q, IOracleAdapter.ResultStatus.Cancelled, 0);
        vm.warp(block.timestamp + FINALITY);
        book.settleMarket(m);
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Cancelled));
        vm.prank(alice);
        assertEq(book.claim(1), 100e6);
        vm.prank(bob);
        assertEq(book.claim(2), 100e6);
        _assertSolvent();
    }

    function test_onlyDisputerCanCorrect() public {
        (, bytes32 q) = _closedWithResult(0);
        vm.prank(reporter);
        vm.expectRevert();
        oracle.correctResult(q, IOracleAdapter.ResultStatus.Resolved, 1);
    }

    // ── finalisation boundary ────────────────────────────────────────────────────────────

    function test_finalisationBoundary_settleAndCancelAreExactlyComplementary() public {
        (uint256 m, bytes32 q) = _closedWithResult(0);
        uint64 finalAt = oracle.getResult(q).finalAt;

        vm.warp(finalAt - 1);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultNotFinal.selector, q));
        book.settleMarket(m);
        uint256 snap = vm.snapshotState();
        vm.prank(manager);
        book.cancelMarket(m, "one second before finality: still allowed");
        vm.revertToState(snap);

        vm.warp(finalAt);
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultAlreadyFinal.selector, m));
        book.cancelMarket(m, "at finality: must be refused");
        book.settleMarket(m);
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Settled));
    }

    // ── claims ───────────────────────────────────────────────────────────────────────────

    function test_manyWinnersClaimInAnyOrder_outstandingReachesZero() public {
        uint256 m = _defaultMarket();
        uint256[] memory aliceIds = new uint256[](3);
        for (uint256 i; i < 3; ++i) aliceIds[i] = _bet(alice, m, 0, 10e6 + i);
        uint256 b1 = _bet(bob, m, 0, 33e6);
        uint256 c1 = _bet(carol, m, 0, 7e6);
        _settle(m, 0);
        uint256 owed = book.outstandingClaims();

        vm.prank(carol);
        uint256 paidC = book.claim(c1);
        vm.prank(alice);
        uint256 paidA = book.claimMany(aliceIds);
        vm.prank(bob);
        uint256 paidB = book.claim(b1);
        assertEq(paidA + paidB + paidC, owed);
        assertEq(book.outstandingClaims(), 0);

        // A second attempt by anyone, in any form, pays nothing.
        vm.prank(alice);
        vm.expectRevert();
        book.claim(aliceIds[0]);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.NotBettor.selector, aliceIds[1]));
        book.claim(aliceIds[1]);
        (uint256 req, uint256 held) = book.solvency();
        assertEq(req, held);
    }

    function test_multipleBetsSameOutcome_reservationIsSumOfGrossMinusStake() public {
        uint256 m = _newMarket(_newEvent(1 days), _odds2(30_000, 13_000), 1e12);
        _bet(alice, m, 0, 100e6); // G0 = 300
        _bet(bob, m, 0, 50e6); //    G0 = 450
        vm.prank(oddsBot);
        book.setOdds(m, _odds2(25_000, 15_000));
        _bet(carol, m, 0, 40e6); //  G0 = 550 (different locked odds)
        _bet(alice, m, 1, 20e6); //  G1 = 30
        // S = 210, worst case outcome 0: 550 - 210 = 340
        assertEq(book.getMarket(m).reserved, 340e6);
        assertEq(book.getOutcome(m, 0).grossPayout, 550e6);
        _settle(m, 0);
        assertEq(book.houseBalance(), HOUSE - 340e6);
        _assertSolvent();
    }

    // ── pause & recovery ─────────────────────────────────────────────────────────────────

    function test_pauseBlocksSettlement_unpauseRecovers() public {
        (uint256 m, bytes32 q) = _closedWithResult(1);
        vm.warp(oracle.getResult(q).finalAt);
        vm.prank(admin);
        book.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        book.settleMarket(m);
        vm.prank(admin);
        book.unpause();
        book.settleMarket(m);
        vm.prank(bob);
        assertGt(book.claim(2), 100e6);
        _assertSolvent();
    }

    // ── invalid outcomes ─────────────────────────────────────────────────────────────────

    function test_oracleRejectsOutcomeIndexAboveItsMaximum() public {
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(MockOracleAdapter.InvalidOutcome.selector, 16));
        oracle.reportResult(keccak256("q"), 16, "too high");
    }

    // ── rounding ─────────────────────────────────────────────────────────────────────────

    /// Many tiny bets round down individually; the aggregate the contract owes never exceeds what it
    /// holds, and every rounding remainder stays with the house.
    function testFuzz_tinyBetsRoundInHouseFavour(uint8 n, uint256 oddsSeed) public {
        n = uint8(bound(n, 1, 40));
        uint256 odds = bound(oddsSeed, 10_100, 99_999);
        uint256 m = _newMarket(_newEvent(1 days), _odds2(odds, 20_000), 1e12);
        uint256 sumNet;
        for (uint256 i; i < n; ++i) {
            _bet(alice, m, 0, 1e6 + i * 7); // odd micro-amounts
            sumNet += book.getBet(i + 1).potentialPayout;
        }
        _settle(m, 0);
        assertEq(book.outstandingClaims(), sumNet);
        uint256[] memory ids = book.getBetIds(alice);
        vm.prank(alice);
        assertEq(book.claimMany(ids), sumNet);
        _assertSolvent();
    }
}
