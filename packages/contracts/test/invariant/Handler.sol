// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BettingMarket} from "../../src/BettingMarket.sol";
import {MockOracleAdapter} from "../../src/MockOracleAdapter.sol";
import {IOracleAdapter} from "../../src/interfaces/IOracleAdapter.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";

/// Drives BettingMarket through random but valid-ish sequences: market creation, odds moves, bets from
/// several bettors, early closes, oracle reports (including bad ones), settlement, cancellation, claims,
/// liquidity movement, fee withdrawal and time travel.
contract Handler is Test {
    BettingMarket public book;
    MockOracleAdapter public oracle;
    MockUSDC public usdc;
    address public admin;
    address public manager;
    address public reporter;
    address public lp;
    address public treasury;

    address[] public bettors;
    uint256[] public marketIds;

    // ghost accounting
    uint256 public ghostPaidOut;
    uint256 public ghostStaked;
    uint256 public ghostBetsAccepted;
    uint256 public ghostSettled;
    uint256 public ghostCancelled;
    mapping(bytes32 => uint256) public calls;

    struct Actors {
        address admin;
        address manager;
        address reporter;
        address lp;
        address treasury;
    }

    constructor(BettingMarket book_, MockOracleAdapter oracle_, MockUSDC usdc_, Actors memory a) {
        book = book_;
        oracle = oracle_;
        usdc = usdc_;
        admin = a.admin;
        manager = a.manager;
        reporter = a.reporter;
        lp = a.lp;
        treasury = a.treasury;
        for (uint256 i; i < 4; ++i) {
            address b = makeAddr(string(abi.encodePacked("bettor", vm.toString(i))));
            bettors.push(b);
            vm.prank(admin);
            usdc.mint(b, 10_000_000e6);
            vm.prank(b);
            usdc.approve(address(book), type(uint256).max);
        }
    }

    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    function bettorCount() external view returns (uint256) {
        return bettors.length;
    }

    function _liveMarkets() private view returns (uint256 n) {
        for (uint256 i; i < marketIds.length; ++i) {
            BettingMarket.MarketStatus st = book.getMarket(marketIds[i]).status;
            if (st == BettingMarket.MarketStatus.Open || st == BettingMarket.MarketStatus.Pending) n++;
        }
    }

    // ───────────────────────────── actions ─────────────────────────────

    function createMarket(uint8 outcomes, uint256 seed, uint256 liabilityCap, uint32 startsIn) external {
        if (marketIds.length >= 40 || _liveMarkets() >= 6) return;
        calls["createMarket"]++;
        outcomes = uint8(bound(outcomes, 2, 4));
        uint256[] memory odds = new uint256[](outcomes);
        for (uint256 i; i < outcomes; ++i) {
            odds[i] = bound(uint256(keccak256(abi.encode(seed, i))), 10_100, 120_000);
        }
        uint64 start = uint64(block.timestamp + bound(startsIn, 1 hours, 3 days));
        vm.startPrank(manager);
        uint256 ev = book.createEvent(bytes32(seed), start);
        uint256 id = book.createMarket(
            BettingMarket.MarketParams({
                eventId: ev,
                ref: bytes32(seed),
                outcomeCount: outcomes,
                initialOdds: odds,
                minStake: 1e6,
                maxStake: 25_000e6,
                maxLiability: bound(liabilityCap, 1_000e6, 500_000e6),
                oracle: oracle
            })
        );
        book.openMarket(id);
        vm.stopPrank();
        marketIds.push(id);
    }

    function placeBet(uint256 mSeed, uint256 bSeed, uint8 outcome, uint256 stake) external {
        if (marketIds.length == 0) return;
        uint256 m = marketIds[mSeed % marketIds.length];
        BettingMarket.Market memory mk = book.getMarket(m);
        outcome = uint8(bound(outcome, 0, mk.outcomeCount - 1));
        stake = bound(stake, 1e6, 25_000e6);
        (uint256 odds,,,, bool ok) = book.quote(m, outcome, stake);
        address b = bettors[bSeed % bettors.length];
        vm.prank(b);
        try book.placeBet(m, outcome, stake, odds) {
            assertTrue(ok, "quote said no but bet was accepted");
            ghostStaked += stake;
            ghostBetsAccepted++;
            calls["placeBet.ok"]++;
        } catch (bytes memory err) {
            assertFalse(ok, "quote said yes but bet was rejected");
            calls["placeBet.rejected"]++;
            calls[bytes32(bytes4(err))]++;
        }
    }

    function setOdds(uint256 mSeed, uint256 seed) external {
        if (marketIds.length == 0) return;
        uint256 m = marketIds[mSeed % marketIds.length];
        BettingMarket.Market memory mk = book.getMarket(m);
        uint256[] memory odds = new uint256[](mk.outcomeCount);
        for (uint256 i; i < odds.length; ++i) {
            odds[i] = bound(uint256(keccak256(abi.encode(seed, i))), 10_100, 120_000);
        }
        vm.prank(admin); // admin is granted ODDS_MANAGER_ROLE in the test setup
        try book.setOdds(m, odds) {
            calls["setOdds"]++;
        } catch {}
    }

    function closeEarly(uint256 mSeed) external {
        if (marketIds.length == 0 || mSeed % 4 != 0) return;
        vm.prank(manager);
        try book.closeMarket(marketIds[mSeed % marketIds.length]) {
            calls["close"]++;
        } catch {}
    }

    function report(uint256 mSeed, uint8 winner, bool cancel) external {
        if (marketIds.length == 0) return;
        uint256 m = marketIds[mSeed % marketIds.length];
        BettingMarket.Market memory mk = book.getMarket(m);
        // Includes deliberately out-of-range winners some of the time.
        // Mostly report after kick-off (the honest case); occasionally before it (a bad/premature report).
        if (block.timestamp < mk.closeTime && mSeed % 5 != 0) return;
        winner = uint8(bound(winner, 0, mk.outcomeCount));
        vm.prank(reporter);
        if (cancel && winner == 0) {
            try oracle.reportCancellation(mk.questionId, "handler") {
                calls["report.cancel"]++;
            } catch {}
        } else {
            try oracle.reportResult(mk.questionId, winner, "handler") {
                calls["report.result"]++;
            } catch {}
        }
    }

    function settle(uint256 mSeed) external {
        if (marketIds.length == 0) return;
        uint256 m = marketIds[mSeed % marketIds.length];
        try book.settleMarket(m) {
            BettingMarket.MarketStatus s = book.getMarket(m).status;
            if (s == BettingMarket.MarketStatus.Settled) ghostSettled++;
            else ghostCancelled++;
            calls["settle"]++;
        } catch {}
    }

    /// The honest happy path in one step: wait for kick-off, report a winner, wait out finality, settle.
    function resolveHonestly(uint256 mSeed, uint8 winner) external {
        if (marketIds.length == 0) return;
        uint256 m = marketIds[mSeed % marketIds.length];
        BettingMarket.Market memory mk = book.getMarket(m);
        if (mk.status == BettingMarket.MarketStatus.Settled || mk.status == BettingMarket.MarketStatus.Cancelled) return;
        if (mk.status == BettingMarket.MarketStatus.Pending) return;
        if (block.timestamp < mk.closeTime) vm.warp(mk.closeTime + 1);
        vm.prank(reporter);
        try oracle.reportResult(mk.questionId, uint8(bound(winner, 0, mk.outcomeCount - 1)), "honest") {} catch {}
        vm.warp(block.timestamp + 31 minutes);
        try book.settleMarket(m) {
            if (book.getMarket(m).status == BettingMarket.MarketStatus.Settled) ghostSettled++;
            else ghostCancelled++;
            calls["settle"]++;
        } catch {}
    }

    function cancel(uint256 mSeed) external {
        if (marketIds.length == 0 || mSeed % 6 != 0) return; // rare: voids end markets early
        vm.prank(manager);
        try book.cancelMarket(marketIds[mSeed % marketIds.length], "handler") {
            ghostCancelled++;
            calls["cancel"]++;
        } catch {}
    }

    function claimAll(uint256 bSeed) external {
        address b = bettors[bSeed % bettors.length];
        uint256[] memory ids = book.getBetIds(b);
        for (uint256 i; i < ids.length; ++i) {
            BettingMarket.BetStatus st = book.betStatus(ids[i]);
            if (st == BettingMarket.BetStatus.Won || st == BettingMarket.BetStatus.Refundable) {
                vm.prank(b);
                ghostPaidOut += book.claim(ids[i]); // must never revert
                calls["claim"]++;
            }
        }
    }

    function depositLiquidity(uint256 amount) external {
        amount = bound(amount, 1e6, 200_000e6);
        vm.prank(admin);
        usdc.mint(lp, amount);
        vm.prank(lp);
        book.depositLiquidity(amount);
        calls["deposit"]++;
    }

    function withdrawLiquidity(uint256 amount) external {
        uint256 free = book.freeLiquidity();
        if (free == 0) return;
        amount = bound(amount, 1, free / 4 + 1); // partial withdrawals; full drains are covered by unit tests
        vm.prank(lp);
        book.withdrawLiquidity(amount, lp); // must never revert within free liquidity
        calls["withdraw"]++;
    }

    function withdrawFees(uint256 amount) external {
        uint256 fees = book.accruedFees();
        if (fees == 0) return;
        vm.prank(treasury);
        book.withdrawFees(bound(amount, 1, fees), treasury);
        calls["fees"]++;
    }

    /// Someone sends tokens straight to the contract — must never break accounting.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000e6);
        vm.prank(admin);
        usdc.mint(address(book), amount);
        calls["donate"]++;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 8 hours));
        calls["warp"]++;
    }
}
