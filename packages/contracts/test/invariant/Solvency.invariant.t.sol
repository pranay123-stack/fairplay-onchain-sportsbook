// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {BettingMarket} from "../../src/BettingMarket.sol";
import {MockOracleAdapter} from "../../src/MockOracleAdapter.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {Handler} from "./Handler.sol";

contract SolvencyInvariantTest is Test {
    BettingMarket book;
    MockOracleAdapter oracle;
    MockUSDC usdc;
    Handler handler;

    address admin = makeAddr("admin");
    address manager = makeAddr("manager");
    address reporter = makeAddr("reporter");
    address lp = makeAddr("lp");
    address treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC(admin);
        book = new BettingMarket(usdc, admin, 250);
        oracle = new MockOracleAdapter(admin, 30 minutes);
        handler = new Handler(book, oracle, usdc, Handler.Actors(admin, manager, reporter, lp, treasury));

        vm.startPrank(admin);
        book.grantRole(book.MARKET_MANAGER_ROLE(), manager);
        book.grantRole(book.ODDS_MANAGER_ROLE(), admin);
        book.grantRole(book.LIQUIDITY_MANAGER_ROLE(), lp);
        book.grantRole(book.TREASURY_ROLE(), treasury);
        book.setOracleAllowed(address(oracle), true);
        oracle.grantRole(oracle.REPORTER_ROLE(), reporter);
        usdc.mint(lp, 250_000e6);
        vm.stopPrank();
        vm.startPrank(lp);
        usdc.approve(address(book), type(uint256).max);
        book.depositLiquidity(250_000e6);
        vm.stopPrank();

        targetContract(address(handler));
    }

    /// I1 — escrow conservation: every token held is attributed to exactly one bucket (donations only add).
    function invariant_escrowConservation() public view {
        (uint256 required, uint256 held) = book.solvency();
        assertGe(held, required);
    }

    /// I2 — liability coverage: reserved house capital never exceeds house capital.
    function invariant_liabilityCoverage() public view {
        assertGe(book.houseBalance(), book.totalReserved());
    }

    /// I3 — the reservation, open stake and outstanding claims all equal what the bets themselves imply.
    function invariant_aggregatesMatchBets() public view {
        uint256 sumReserved;
        uint256 sumOpenStake;
        for (uint256 i; i < handler.marketCount(); ++i) {
            (uint256 r, uint256 open) = _checkMarket(handler.marketIds(i));
            sumReserved += r;
            sumOpenStake += open;
        }
        assertEq(book.totalReserved(), sumReserved, "totalReserved");
        assertEq(book.openStake(), sumOpenStake, "openStake");
        assertEq(book.outstandingClaims(), _owedFromBets(), "outstandingClaims");
    }

    function _checkMarket(uint256 m) private view returns (uint256 reserved, uint256 openStake) {
        BettingMarket.Market memory mk = book.getMarket(m);
        bool live = mk.status != BettingMarket.MarketStatus.Settled && mk.status != BettingMarket.MarketStatus.Cancelled;
        uint256 s;
        uint256 maxGross;
        for (uint256 o; o < mk.outcomeCount; ++o) {
            BettingMarket.OutcomeBook memory ob = book.getOutcome(m, o);
            s += ob.stake;
            if (ob.grossPayout > maxGross) maxGross = ob.grossPayout;
        }
        assertEq(s, mk.totalStake, "market stake");
        uint256 expected = live && maxGross > s ? maxGross - s : 0;
        assertEq(mk.reserved, expected, "market reservation = max(0, maxG - S)");
        assertLe(mk.reserved, mk.maxLiability, "per-market cap");
        return (mk.reserved, live ? mk.totalStake : 0);
    }

    function _owedFromBets() private view returns (uint256 owed) {
        for (uint256 id = 1; id <= book.betCount(); ++id) {
            BettingMarket.BetStatus st = book.betStatus(id);
            if (st == BettingMarket.BetStatus.Won) owed += book.getBet(id).potentialPayout;
            else if (st == BettingMarket.BetStatus.Refundable) owed += book.getBet(id).stake;
        }
    }

    /// I4 — the headline guarantee: settle EVERY live market at its worst outcome for the house, then
    ///      claim EVERY claimable bet. Nothing may revert and the contract must stay solvent.
    function invariant_worstCaseIsAlwaysPayable() public {
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 4 days); // past every kick-off (markets start within 3 days)

        for (uint256 i; i < handler.marketCount(); ++i) {
            if (book.paused()) break;
            _forceWorstCase(handler.marketIds(i));
        }

        assertEq(book.totalReserved(), 0);
        assertEq(book.openStake(), 0);

        for (uint256 a; a < handler.bettorCount(); ++a) {
            address b = handler.bettors(a);
            uint256[] memory ids = book.getBetIds(b);
            for (uint256 j; j < ids.length; ++j) {
                BettingMarket.BetStatus st = book.betStatus(ids[j]);
                if (st == BettingMarket.BetStatus.Won || st == BettingMarket.BetStatus.Refundable) {
                    vm.prank(b);
                    book.claim(ids[j]);
                }
            }
        }
        assertEq(book.outstandingClaims(), 0, "every claim paid");
        (uint256 required, uint256 held) = book.solvency();
        assertGe(held, required);
        assertGe(book.houseBalance(), 0);
        vm.revertToState(snap);
    }

    function _forceWorstCase(uint256 m) private {
        BettingMarket.Market memory mk = book.getMarket(m);
        if (mk.status == BettingMarket.MarketStatus.Settled || mk.status == BettingMarket.MarketStatus.Cancelled) return;
        uint8 worst;
        uint256 maxGross;
        for (uint8 o; o < mk.outcomeCount; ++o) {
            uint256 g = book.getOutcome(m, o).grossPayout;
            if (g >= maxGross) (maxGross, worst) = (g, o);
        }
        // A result may already be on record (possibly a bad one). Whatever it is, the market must end up
        // either settled or cancellable — it must never be stuck holding stakes.
        vm.prank(reporter);
        try oracle.reportResult(mk.questionId, worst, "worst-case") {} catch {}
        vm.warp(block.timestamp + 31 minutes);
        try book.settleMarket(m) {}
        catch {
            vm.prank(manager);
            book.cancelMarket(m, "worst-case sweep");
        }
    }

    /// Appends one line of per-run activity to cache/invariant-stats.csv so the whole campaign's coverage
    /// can be measured (forge only prints the logs of the final run). See scripts/invariant-stats.sh.
    function afterInvariant() external {
        string memory line = string.concat(
            vm.toString(handler.ghostBetsAccepted()), ",",
            vm.toString(handler.calls("placeBet.rejected")), ",",
            vm.toString(handler.ghostSettled()), ",",
            vm.toString(handler.ghostCancelled()), ",",
            vm.toString(handler.calls("claim")), ",",
            vm.toString(handler.calls("withdraw")), ",",
            vm.toString(handler.calls(bytes32(BettingMarket.InsufficientLiquidity.selector))), ",",
            vm.toString(handler.calls(bytes32(BettingMarket.BettingClosed.selector))), ",",
            vm.toString(handler.calls(bytes32(BettingMarket.InvalidStatus.selector))), ",",
            vm.toString(handler.calls(bytes32(BettingMarket.MarketLiabilityCapExceeded.selector)))
        );
        vm.writeLine("cache/invariant-stats.csv", line);
    }
}
