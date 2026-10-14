// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {BettingMarket} from "../src/BettingMarket.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {MockOracleAdapter} from "../src/MockOracleAdapter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract BettingMarketTest is BaseTest {
    // ─────────────────────────── 1. successful bet placement ───────────────────────────

    function test_placeBet_locksOddsAndEscrowsStake() public {
        uint256 m = _defaultMarket();
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, true, true, true);
        emit BettingMarket.BetPlaced(1, m, alice, 0, 100e6, 25_000, 247e6);
        uint256 id = _bet(alice, m, 0, 100e6);

        BettingMarket.Bet memory b = book.getBet(id);
        assertEq(b.id, 1);
        assertEq(b.bettor, alice);
        assertEq(b.marketId, m);
        assertEq(b.outcomeId, 0);
        assertEq(b.stake, 100e6);
        assertEq(b.odds, 25_000);
        // gross 250, profit 150, fee 2% of profit = 3 → net 247
        assertEq(b.potentialPayout, 247e6);
        assertFalse(b.claimed);

        assertEq(usdc.balanceOf(alice), aliceBefore - 100e6);
        assertEq(usdc.balanceOf(address(book)), HOUSE + 100e6);
        assertEq(book.openStake(), 100e6);
        assertEq(book.totalReserved(), 150e6); // worst case: home wins, house pays 250 having taken 100
        assertEq(book.getMarket(m).reserved, 150e6);
        assertEq(uint8(book.betStatus(id)), uint8(BettingMarket.BetStatus.Open));
        assertEq(book.getBetIds(alice).length, 1);
        _assertSolvent();
    }

    function test_quote_matchesPlacedBet() public {
        uint256 m = _defaultMarket();
        (uint256 odds, uint256 gross, uint256 fee, uint256 net, bool ok) = book.quote(m, 2, 333e6);
        assertTrue(ok);
        uint256 id = _bet(alice, m, 2, 333e6);
        BettingMarket.Bet memory b = book.getBet(id);
        assertEq(b.odds, odds);
        assertEq(b.potentialPayout, net);
        assertEq(gross - fee, net);
    }

    // ─────────────────────────── 2. winning payout ───────────────────────────

    function test_winningBet_claimsNetPayout() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        _settle(m, 0);

        assertEq(uint8(book.betStatus(id)), uint8(BettingMarket.BetStatus.Won));
        assertEq(book.outstandingClaims(), 247e6);
        assertEq(book.accruedFees(), 3e6);
        assertEq(book.houseBalance(), HOUSE - 150e6); // house paid gross profit 150
        assertEq(book.totalReserved(), 0);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = book.claim(id);
        assertEq(paid, 247e6);
        assertEq(usdc.balanceOf(alice), before + 247e6);
        assertEq(uint8(book.betStatus(id)), uint8(BettingMarket.BetStatus.Claimed));
        assertEq(book.outstandingClaims(), 0);
        _assertSolvent();
    }

    // ─────────────────────────── 3. losing bet ───────────────────────────

    function test_losingBet_stakeGoesToHouse_andCannotClaim() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        _settle(m, 1);

        assertEq(uint8(book.betStatus(id)), uint8(BettingMarket.BetStatus.Lost));
        assertEq(book.houseBalance(), HOUSE + 100e6);
        assertEq(book.outstandingClaims(), 0);
        assertEq(book.openStake(), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.NothingToClaim.selector, id, BettingMarket.BetStatus.Lost));
        book.claim(id);
        _assertSolvent();
    }

    // ─────────────────────────── 4. cancelled market refund ───────────────────────────

    function test_cancelledMarket_refundsEveryStake() public {
        uint256 m = _defaultMarket();
        uint256 a = _bet(alice, m, 0, 100e6);
        uint256 b = _bet(bob, m, 2, 40e6);

        vm.prank(manager);
        book.cancelMarket(m, "fixture postponed");
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Cancelled));
        assertEq(book.totalReserved(), 0);
        assertEq(book.outstandingClaims(), 140e6);
        assertEq(book.houseBalance(), HOUSE); // house neither gains nor loses on a void

        uint256 aBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        assertEq(book.claim(a), 100e6);
        assertEq(usdc.balanceOf(alice), aBefore + 100e6);
        vm.prank(bob);
        assertEq(book.claim(b), 40e6);
        assertEq(book.outstandingClaims(), 0);
        _assertSolvent();
    }

    function test_oracleCancellation_voidsMarket_evenBeforeKickoff() public {
        uint256 m = _defaultMarket();
        uint256 a = _bet(alice, m, 1, 10e6);
        bytes32 q = book.getMarket(m).questionId;
        vm.prank(reporter);
        oracle.reportCancellation(q, "abandoned");
        vm.warp(block.timestamp + FINALITY);
        book.settleMarket(m); // permissionless
        assertEq(uint8(book.betStatus(a)), uint8(BettingMarket.BetStatus.Refundable));
        vm.prank(alice);
        assertEq(book.claim(a), 10e6);
    }

    function test_cannotCancelAfterFinalResolvedResult() public {
        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 100e6);
        BettingMarket.Market memory mk = book.getMarket(m);
        vm.warp(mk.closeTime + 1);
        vm.prank(reporter);
        oracle.reportResult(mk.questionId, 0, "test");

        // Within the dispute window the manager may still void it…
        uint256 snap = vm.snapshotState();
        vm.prank(manager);
        book.cancelMarket(m, "integrity concern");
        vm.revertToState(snap);

        // …but once the result is final it must be honoured.
        vm.warp(block.timestamp + FINALITY);
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultAlreadyFinal.selector, m));
        book.cancelMarket(m, "too late");
    }

    // ─────────────────────────── 5. unauthorized settlement ───────────────────────────

    function test_unauthorizedReporter_cannotPublishResult() public {
        uint256 m = _defaultMarket();
        bytes32 q = book.getMarket(m).questionId;
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, oracle.REPORTER_ROLE())
        );
        vm.prank(alice);
        oracle.reportResult(q, 0, "trust me");
    }

    function test_settle_requiresFinalOracleResult() public {
        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 100e6);
        BettingMarket.Market memory mk = book.getMarket(m);
        vm.warp(mk.closeTime + 1);

        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultNotFinal.selector, mk.questionId));
        book.settleMarket(m);

        vm.prank(reporter);
        oracle.reportResult(mk.questionId, 0, "test");
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultNotFinal.selector, mk.questionId));
        book.settleMarket(m); // still inside the dispute window

        vm.warp(block.timestamp + FINALITY);
        book.settleMarket(m);
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Settled));
    }

    function test_settle_ignoresResultsFromAnotherOracle() public {
        // A rogue adapter that the attacker fully controls cannot be used: markets are bound to their
        // adapter at creation, and only allow-listed adapters can be bound.
        MockOracleAdapter rogue = new MockOracleAdapter(alice, 0);
        uint256 ev = _newEvent(1 days);
        BettingMarket.MarketParams memory p = BettingMarket.MarketParams({
            eventId: ev,
            ref: bytes32("x"),
            outcomeCount: 2,
            initialOdds: _odds2(19_000, 19_000),
            minStake: 1e6,
            maxStake: 1e9,
            maxLiability: 1e12,
            oracle: rogue
        });
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.OracleNotAllowed.selector, address(rogue)));
        book.createMarket(p);
    }

    function test_resultReportedBeforeClose_isRejected() public {
        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 100e6);
        BettingMarket.Market memory mk = book.getMarket(m);
        vm.prank(reporter);
        oracle.reportResult(mk.questionId, 0, "pre-arranged"); // before kick-off
        vm.warp(mk.closeTime + FINALITY);
        vm.expectRevert(
            abi.encodeWithSelector(BettingMarket.ResultPredatesClose.selector, uint64(1_800_000_000), mk.closeTime)
        );
        book.settleMarket(m);
    }

    function test_noSettlementWhileBettingOpen() public {
        uint256 m = _defaultMarket();
        bytes32 q = book.getMarket(m).questionId;
        vm.prank(reporter);
        oracle.reportResult(q, 0, "test");
        vm.warp(block.timestamp + FINALITY); // finality passed, but kick-off (1 day) has not
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Open));
        book.settleMarket(m);
    }

    function test_onlyManagerCanCreateAndCancel() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, book.MARKET_MANAGER_ROLE()
            )
        );
        vm.prank(alice);
        book.createEvent(bytes32("e"), uint64(block.timestamp + 1 days));

        uint256 m = _defaultMarket();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, book.MARKET_MANAGER_ROLE()
            )
        );
        vm.prank(alice);
        book.cancelMarket(m, "griefing");

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, book.ODDS_MANAGER_ROLE())
        );
        vm.prank(alice);
        book.setOdds(m, _odds3(11_000, 11_000, 11_000));
    }

    // ─────────────────────────── 6. double claim ───────────────────────────

    function test_doubleClaim_reverts() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        _settle(m, 0);
        vm.startPrank(alice);
        book.claim(id);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.NothingToClaim.selector, id, BettingMarket.BetStatus.Claimed));
        book.claim(id);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (id, id);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.NothingToClaim.selector, id, BettingMarket.BetStatus.Claimed));
        book.claimMany(ids);
        vm.stopPrank();
    }

    function test_onlyBettorCanClaim() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        _settle(m, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.NotBettor.selector, id));
        book.claim(id);
    }

    function test_cannotClaimOpenBet() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.NothingToClaim.selector, id, BettingMarket.BetStatus.Open));
        book.claim(id);
    }

    // ─────────────────────────── 7. insufficient liquidity ───────────────────────────

    function test_insufficientLiquidity_rejectsBet() public {
        uint256 m = _defaultMarket();
        // House holds 100k. A 50k stake at 3.40 needs 120k of house capital.
        uint256 odds = book.getOutcome(m, 1).odds;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InsufficientLiquidity.selector, 120_000e6, HOUSE));
        book.placeBet(m, 1, 50_000e6, odds);
        (,,,, bool ok) = book.quote(m, 1, 50_000e6);
        assertFalse(ok);
    }

    function test_marketLiabilityCap_rejectsBet() public {
        uint256 m = _newMarket(_newEvent(1 days), _odds2(20_000, 20_000), 500e6);
        _bet(alice, m, 0, 500e6); // liability exactly 500
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.MarketLiabilityCapExceeded.selector, 501e6, 500e6));
        book.placeBet(m, 0, 1e6, 20_000);
    }

    function test_reservedLiquidity_cannotBeWithdrawn() public {
        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 1_000e6); // reserves 1,500
        assertEq(book.freeLiquidity(), HOUSE - 1_500e6);

        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(BettingMarket.AmountExceedsFree.selector, HOUSE, HOUSE - 1_500e6)
        );
        book.withdrawLiquidity(HOUSE, lp);

        vm.prank(lp);
        book.withdrawLiquidity(HOUSE - 1_500e6, lp);
        assertEq(book.freeLiquidity(), 0);
        _assertSolvent();

        // The house is now exactly covered; even the worst outcome is still payable.
        _settle(m, 0);
        vm.prank(alice);
        book.claim(1);
        _assertSolvent();
    }

    // ─────────────────────────── 8. betting after closure ───────────────────────────

    function test_betAfterManualClose_reverts() public {
        uint256 m = _defaultMarket();
        vm.prank(manager);
        book.closeMarket(m);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Closed));
        book.placeBet(m, 0, 10e6, 25_000);
    }

    function test_betAfterKickoff_reverts_evenIfNotClosed() public {
        uint256 m = _defaultMarket();
        uint64 closeTime = book.getMarket(m).closeTime;
        vm.warp(closeTime);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.BettingClosed.selector, m, closeTime));
        book.placeBet(m, 0, 10e6, 25_000);
    }

    function test_betOnPendingMarket_reverts() public {
        uint256 ev = _newEvent(1 days);
        BettingMarket.MarketParams memory p = BettingMarket.MarketParams({
            eventId: ev,
            ref: bytes32("p"),
            outcomeCount: 2,
            initialOdds: _odds2(19_000, 19_000),
            minStake: 1e6,
            maxStake: 1e9,
            maxLiability: 1e12,
            oracle: oracle
        });
        vm.prank(manager);
        uint256 m = book.createMarket(p);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Pending));
        book.placeBet(m, 0, 10e6, 19_000);
    }

    // ─────────────────────────── 9. incorrect / stale odds ───────────────────────────

    function test_staleOdds_rejected_andLockedOddsSurviveUpdates() public {
        uint256 m = _defaultMarket();
        uint256 early = _bet(alice, m, 0, 100e6); // locked at 2.50

        vm.prank(oddsBot);
        book.setOdds(m, _odds3(21_000, 34_000, 33_000));
        assertEq(book.getMarket(m).oddsVersion, 2);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.OddsChanged.selector, 25_000, 21_000));
        book.placeBet(m, 0, 100e6, 25_000);

        uint256 late = _bet(bob, m, 0, 100e6);
        assertEq(book.getBet(early).odds, 25_000);
        assertEq(book.getBet(late).odds, 21_000);

        _settle(m, 0);
        vm.prank(alice);
        assertEq(book.claim(early), 247e6);
        vm.prank(bob);
        assertEq(book.claim(late), 207_800_000); // gross 210, fee 2% of 110 = 2.2 → net 207.8
    }

    function test_invalidOdds_rejected() public {
        uint256 m = _defaultMarket();
        vm.startPrank(oddsBot);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidOdds.selector, 10_000));
        book.setOdds(m, _odds3(10_000, 30_000, 30_000)); // 1.00 = no-profit odds
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidOdds.selector, 1_000_001));
        book.setOdds(m, _odds3(1_000_001, 30_000, 30_000));
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidOutcomeCount.selector, 2));
        book.setOdds(m, _odds2(20_000, 20_000));
        vm.stopPrank();
    }

    function test_invalidOutcome_and_stakeLimits() public {
        uint256 m = _defaultMarket();
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidOutcome.selector, 3));
        book.placeBet(m, 3, 10e6, 25_000);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.StakeOutOfRange.selector, 1e6 - 1, 1e6, 50_000e6));
        book.placeBet(m, 0, 1e6 - 1, 25_000);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.StakeOutOfRange.selector, 50_000e6 + 1, 1e6, 50_000e6));
        book.placeBet(m, 0, 50_000e6 + 1, 25_000);
        vm.stopPrank();
    }

    // ─────────────────────────── 11. escrow solvency ───────────────────────────

    function test_escrowBuckets_sumToBalance_throughFullLifecycle() public {
        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 300e6);
        _bet(bob, m, 1, 200e6);
        _bet(carol, m, 2, 150e6);
        (uint256 req, uint256 held) = book.solvency();
        assertEq(req, held);
        _settle(m, 1);
        (req, held) = book.solvency();
        assertEq(req, held);
        vm.prank(bob);
        book.claim(2);
        (req, held) = book.solvency();
        assertEq(req, held);
        uint256 fees = book.accruedFees();
        vm.prank(treasury);
        book.withdrawFees(fees, treasury);
        (req, held) = book.solvency();
        assertEq(req, held);
    }

    // ─────────────────────────── 12. state transitions ───────────────────────────

    function test_stateMachine() public {
        uint256 ev = _newEvent(1 days);
        BettingMarket.MarketParams memory p = BettingMarket.MarketParams({
            eventId: ev,
            ref: bytes32("s"),
            outcomeCount: 2,
            initialOdds: _odds2(19_000, 19_000),
            minStake: 1e6,
            maxStake: 1e9,
            maxLiability: 1e12,
            oracle: oracle
        });
        vm.startPrank(manager);
        uint256 m = book.createMarket(p);
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Pending));

        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Pending));
        book.closeMarket(m);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Pending));
        book.reopenMarket(m);

        book.openMarket(m);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Open));
        book.openMarket(m);

        book.closeMarket(m); // early close (suspension)
        assertEq(book.getMarket(m).closedAt, uint64(block.timestamp));
        book.reopenMarket(m);
        assertEq(uint8(book.getMarket(m).status), uint8(BettingMarket.MarketStatus.Open));
        vm.stopPrank();

        // Non-managers cannot close before kick-off, but anyone can after.
        uint64 closeTime = book.getMarket(m).closeTime;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.TooEarlyToClose.selector, m, closeTime));
        book.closeMarket(m);
        vm.warp(closeTime + 5);
        vm.prank(alice);
        book.closeMarket(m);
        assertEq(book.getMarket(m).closedAt, closeTime); // clamped to kick-off

        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.BettingClosed.selector, m, closeTime));
        book.reopenMarket(m);

        _settle(m, 1);
        vm.startPrank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Settled));
        book.cancelMarket(m, "no");
        vm.stopPrank();
        vm.prank(oddsBot);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Settled));
        book.setOdds(m, _odds2(19_000, 19_000));
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidStatus.selector, m, BettingMarket.MarketStatus.Settled));
        book.settleMarket(m);
    }

    function test_cannotReopenAfterOracleReport() public {
        uint256 m = _defaultMarket();
        vm.prank(manager);
        book.closeMarket(m);
        bytes32 q = book.getMarket(m).questionId;
        vm.prank(reporter);
        oracle.reportResult(q, 0, "test");
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.ResultPending.selector, m));
        book.reopenMarket(m);
    }

    function test_eventAndMarketCreationValidation() public {
        vm.startPrank(manager);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.StartTimeInPast.selector, uint64(block.timestamp)));
        book.createEvent(bytes32("e"), uint64(block.timestamp));
        BettingMarket.MarketParams memory p = BettingMarket.MarketParams({
            eventId: 99,
            ref: bytes32("s"),
            outcomeCount: 2,
            initialOdds: _odds2(19_000, 19_000),
            minStake: 1e6,
            maxStake: 1e9,
            maxLiability: 1e12,
            oracle: oracle
        });
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.UnknownEvent.selector, 99));
        book.createMarket(p);
        p.eventId = book.createEvent(bytes32("e"), uint64(block.timestamp + 1 hours));
        p.outcomeCount = 1;
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidOutcomeCount.selector, 1));
        book.createMarket(p);
        p.outcomeCount = 2;
        p.minStake = 0;
        vm.expectRevert(BettingMarket.InvalidStakeLimits.selector);
        book.createMarket(p);
        vm.stopPrank();
    }

    // ─────────────────────────── 13. multiple simultaneous bettors ───────────────────────────

    function test_multipleBettors_netting_andSettlement() public {
        uint256 m = _defaultMarket(); // 2.50 / 3.40 / 2.80
        _bet(alice, m, 0, 400e6); // G0 = 1000
        _bet(bob, m, 1, 300e6); //   G1 = 1020
        _bet(carol, m, 2, 300e6); // G2 = 840
        // S = 1000; worst case is a draw: 1020 - 1000 = 20. Netting makes this book nearly self-funding.
        assertEq(book.getMarket(m).reserved, 20e6);
        assertEq(book.totalReserved(), 20e6);

        _settle(m, 1);
        // Bob: gross 1020, profit 720, fee 14.4 → net 1005.6
        assertEq(book.getBet(2).potentialPayout, 1_005_600_000);
        assertEq(book.houseBalance(), HOUSE - 20e6);
        assertEq(book.accruedFees(), 14_400_000);
        vm.prank(bob);
        book.claim(2);
        vm.prank(alice);
        vm.expectRevert();
        book.claim(1);
        _assertSolvent();
        (uint256 req, uint256 held) = book.solvency();
        assertEq(req, held);
    }

    function test_hedgingBetReducesReservation() public {
        uint256 m = _newMarket(_newEvent(1 days), _odds2(20_000, 20_000), 1e12);
        _bet(alice, m, 0, 1_000e6);
        assertEq(book.totalReserved(), 1_000e6);
        _bet(bob, m, 1, 1_000e6); // perfectly balanced book
        assertEq(book.totalReserved(), 0);
        assertEq(book.freeLiquidity(), HOUSE);
    }

    // ─────────────────────────── 14. multiple markets sharing collateral ───────────────────────────

    function test_marketsShareOneCollateralPool() public {
        uint256 m1 = _newMarket(_newEvent(1 days), _odds2(30_000, 15_000), 1e12);
        uint256 m2 = _newMarket(_newEvent(2 days), _odds2(30_000, 15_000), 1e12);

        _bet(alice, m1, 0, 40_000e6); // reserves 80k
        assertEq(book.freeLiquidity(), 20_000e6);

        // m2 needs 2x stake; only 20k free → a 10k bet fits exactly, 10k + 1 does not.
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InsufficientLiquidity.selector, 100_000e6 + 2, HOUSE));
        book.placeBet(m2, 0, 10_000e6 + 1, 30_000);
        _bet(bob, m2, 0, 10_000e6);
        assertEq(book.freeLiquidity(), 0);

        // Settling m1 with the house winning frees its reservation AND adds alice's stake.
        _settle(m1, 1);
        assertEq(book.freeLiquidity(), 120_000e6); // 100k + 40k stake won - 20k still reserved for m2
        // Settling m2 with bob winning pays from house capital reserved for it.
        _settle(m2, 0);
        vm.prank(bob);
        book.claim(2);
        assertEq(book.houseBalance(), HOUSE + 40_000e6 - 20_000e6);
        _assertSolvent();
    }

    // ─────────────────────────── 15. decimal precision ───────────────────────────

    function test_precision_roundsDownInContractFavour() public view {
        // 1 micro-USDC at 1.01: gross = floor(1 * 10100 / 1e4) = 1 → no profit, no fee.
        (uint256 g, uint256 f, uint256 n) = book.computePayout(1, 10_100, 200);
        assertEq(g, 1);
        assertEq(f, 0);
        assertEq(n, 1);
        // 3.333333 USDC at 3.3333 → gross 11.11099889 → 11.110998 (floor to 6dp)
        (g, f, n) = book.computePayout(3_333_333, 33_333, 200);
        assertEq(g, 11_110_998);
        assertEq(f, 155_553); // floor(7_777_665 * 200 / 10_000) = floor(155_553.3)
        assertEq(n, g - f);
        // Max stake at max odds does not overflow and is exact.
        (g,,) = book.computePayout(50_000e6, 1_000_000, 0);
        assertEq(g, 5_000_000e6);
    }

    // ─────────────────────────── 16. fee accounting ───────────────────────────

    function test_fees_snapshotPerMarket_andTreasuryWithdrawal() public {
        uint256 m = _defaultMarket(); // 2% fee snapshot
        vm.prank(admin);
        book.setFeeBps(500); // later markets: 5%
        uint256 m2 = _defaultMarket();
        assertEq(book.getMarket(m).feeBps, 200);
        assertEq(book.getMarket(m2).feeBps, 500);

        _bet(alice, m, 0, 100e6); // fee 3
        _bet(bob, m2, 0, 100e6); // fee 7.5
        _settle(m, 0);
        _settle(m2, 0);
        assertEq(book.accruedFees(), 10_500_000);

        vm.prank(alice);
        vm.expectRevert();
        book.withdrawFees(1, alice);

        vm.prank(treasury);
        book.withdrawFees(10_500_000, treasury);
        assertEq(usdc.balanceOf(treasury), 10_500_000);
        assertEq(book.accruedFees(), 0);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.FeeTooHigh.selector, 1_001));
        book.setFeeBps(1_001);
    }

    function test_losingBetsPayNoFee() public {
        uint256 m = _defaultMarket();
        _bet(alice, m, 0, 100e6);
        _settle(m, 2);
        assertEq(book.accruedFees(), 0);
    }

    // ─────────────────────────── pause ───────────────────────────

    function test_pause_blocksNewRisk_butNeverClaims() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        uint256 m2 = _defaultMarket();
        uint256 id2 = _bet(bob, m2, 0, 50e6);
        _settle(m, 0);
        vm.prank(manager);
        book.cancelMarket(m2, "void");

        vm.prank(admin);
        book.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        book.placeBet(m, 0, 1e6, 25_000);

        vm.prank(alice);
        book.claim(id); // winnings still claimable
        vm.prank(bob);
        book.claim(id2); // refunds still claimable

        bytes32 pauserRole = book.PAUSER_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, pauserRole)
        );
        book.unpause();
    }

    // ─────────────────────────── oracle adapter ───────────────────────────

    function test_oracle_correctionWindow() public {
        bytes32 q = keccak256("q");
        vm.prank(reporter);
        oracle.reportResult(q, 1, "feed");
        vm.prank(reporter);
        vm.expectRevert(abi.encodeWithSelector(MockOracleAdapter.AlreadyReported.selector, q));
        oracle.reportResult(q, 2, "feed");

        vm.prank(admin); // admin holds DISPUTER_ROLE
        oracle.correctResult(q, IOracleAdapter.ResultStatus.Resolved, 2);
        IOracleAdapter.OracleResult memory r = oracle.getResult(q);
        assertEq(r.winningOutcome, 2);
        assertEq(r.finalAt, block.timestamp + FINALITY); // window restarted
        assertFalse(oracle.isFinal(q));

        vm.warp(block.timestamp + FINALITY);
        assertTrue(oracle.isFinal(q));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MockOracleAdapter.AlreadyFinal.selector, q));
        oracle.correctResult(q, IOracleAdapter.ResultStatus.Resolved, 0);
    }

    function test_oracle_outOfRangeWinner_cannotSettle_butCanBeCancelled() public {
        uint256 m = _defaultMarket(); // 3 outcomes
        _bet(alice, m, 0, 10e6);
        BettingMarket.Market memory mk = book.getMarket(m);
        vm.warp(mk.closeTime + 1);
        vm.prank(reporter);
        oracle.reportResult(mk.questionId, 7, "bad feed");
        vm.warp(block.timestamp + FINALITY);
        vm.expectRevert(abi.encodeWithSelector(BettingMarket.InvalidResult.selector, 7));
        book.settleMarket(m);
        vm.prank(manager);
        book.cancelMarket(m, "invalid oracle result");
        vm.prank(alice);
        assertEq(book.claim(1), 10e6);
    }

    /// Regression (found by the worst-case invariant): a valid winner reported BEFORE kick-off becomes final,
    /// so settleMarket rejects it (predates close). cancelMarket used to reject it too ("final"), leaving the
    /// market unsettleable and unrefundable forever.
    function test_regression_prematureFinalResult_doesNotLockStakes() public {
        uint256 m = _defaultMarket();
        uint256 id = _bet(alice, m, 0, 100e6);
        bytes32 q = book.getMarket(m).questionId;
        vm.prank(reporter);
        oracle.reportResult(q, 0, "premature");
        vm.warp(book.getMarket(m).closeTime + FINALITY);
        vm.expectRevert();
        book.settleMarket(m);
        vm.prank(manager);
        book.cancelMarket(m, "premature oracle result");
        vm.prank(alice);
        assertEq(book.claim(id), 100e6);
        _assertSolvent();
    }

    function test_oracle_rejectsEmptySource() public {
        vm.prank(reporter);
        vm.expectRevert(MockOracleAdapter.EmptySource.selector);
        oracle.reportResult(keccak256("q"), 0, "");
    }

    // ─────────────────────────── faucet ───────────────────────────

    function test_faucet_rateLimited() public {
        address dave = makeAddr("dave");
        vm.prank(dave);
        usdc.faucet();
        assertEq(usdc.balanceOf(dave), 1_000e6);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.FaucetCooldownActive.selector, block.timestamp + 1 hours));
        usdc.faucet();
        assertEq(usdc.faucetAvailableIn(dave), 1 hours);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(dave);
        usdc.faucet();
        assertEq(usdc.balanceOf(dave), 2_000e6);
        assertEq(usdc.decimals(), 6);

        uint256 aliceBal = usdc.balanceOf(alice);
        vm.prank(alice); // already holds 1M ≥ cap
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.FaucetBalanceCapReached.selector, aliceBal, 10_000e6));
        usdc.faucet();

        vm.prank(dave);
        vm.expectRevert();
        usdc.mint(dave, 1);
    }
}
