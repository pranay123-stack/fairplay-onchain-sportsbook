// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {BettingMarket} from "../src/BettingMarket.sol";

contract FuzzTest is BaseTest {
    function testFuzz_payoutMath(uint256 stake, uint256 odds, uint16 fee) public view {
        stake = bound(stake, 1, 1e15);
        odds = bound(odds, book.MIN_ODDS(), book.MAX_ODDS());
        fee = uint16(bound(fee, 0, book.MAX_FEE_BPS()));
        (uint256 gross, uint256 f, uint256 net) = book.computePayout(stake, odds, fee);
        assertEq(gross, stake * odds / 1e4);
        assertGe(gross, stake);
        assertLe(f, (gross - stake) * fee / 1e4);
        assertEq(net, gross - f);
        assertGe(net, stake, "a winning bet never returns less than its stake");
    }

    /// Any bet the contract accepts can be paid in full whichever outcome wins.
    function testFuzz_acceptedBetIsAlwaysPayable(uint256 stake, uint256 o0, uint256 o1, uint256 o2, uint8 pick, uint8 winner)
        public
    {
        stake = bound(stake, 1e6, 50_000e6);
        uint256 m = _newMarket(
            _newEvent(1 days),
            _odds3(bound(o0, 10_100, 1_000_000), bound(o1, 10_100, 1_000_000), bound(o2, 10_100, 1_000_000)),
            type(uint256).max
        );
        pick = uint8(bound(pick, 0, 2));
        winner = uint8(bound(winner, 0, 2));

        (,,, uint256 net, bool ok) = book.quote(m, pick, stake);
        uint256 odds = book.getOutcome(m, pick).odds;
        vm.prank(alice);
        if (!ok) {
            vm.expectRevert();
            book.placeBet(m, pick, stake, odds);
            return;
        }
        uint256 id = book.placeBet(m, pick, stake, odds);
        _assertSolvent();

        _settle(m, winner);
        _assertSolvent();
        if (pick == winner) {
            uint256 before = usdc.balanceOf(alice);
            vm.prank(alice);
            book.claim(id);
            assertEq(usdc.balanceOf(alice), before + net);
        }
        (uint256 required, uint256 held) = book.solvency();
        assertEq(required, held);
    }

    /// Several bettors on several outcomes; every possible settlement leaves the contract solvent and
    /// the house delta equals S - G_w exactly.
    function testFuzz_manyBets_everyOutcomeSettlesSolvently(uint256[6] memory stakes, uint8[6] memory picks, uint8 winner)
        public
    {
        uint256 m = _defaultMarket();
        address[3] memory who = [alice, bob, carol];
        uint256 totalStake;
        uint256[3] memory grossByOutcome;
        for (uint256 i; i < 6; ++i) {
            uint256 s = bound(stakes[i], 1e6, 5_000e6);
            uint8 p = uint8(bound(picks[i], 0, 2));
            (, uint256 g,,, bool ok) = book.quote(m, p, s);
            if (!ok) continue;
            _bet(who[i % 3], m, p, s);
            totalStake += s;
            grossByOutcome[p] += g;
        }
        winner = uint8(bound(winner, 0, 2));
        uint256 houseBefore = book.houseBalance();
        _settle(m, winner);
        assertEq(int256(book.houseBalance()) - int256(houseBefore), int256(totalStake) - int256(grossByOutcome[winner]));
        _assertSolvent();

        uint256[] memory ids = new uint256[](0);
        for (uint256 a; a < 3; ++a) {
            ids = book.getBetIds(who[a]);
            for (uint256 j; j < ids.length; ++j) {
                if (book.betStatus(ids[j]) == BettingMarket.BetStatus.Won) {
                    vm.prank(who[a]);
                    book.claim(ids[j]);
                }
            }
        }
        assertEq(book.outstandingClaims(), 0);
        (uint256 required, uint256 held) = book.solvency();
        assertEq(required, held);
    }

    function testFuzz_withdrawNeverTouchesReserved(uint256 stake, uint256 amount) public {
        uint256 m = _defaultMarket();
        stake = bound(stake, 1e6, 40_000e6);
        _bet(alice, m, 1, stake);
        uint256 free = book.freeLiquidity();
        amount = bound(amount, 1, HOUSE * 2);
        vm.prank(lp);
        if (amount > free) {
            vm.expectRevert(abi.encodeWithSelector(BettingMarket.AmountExceedsFree.selector, amount, free));
            book.withdrawLiquidity(amount, lp);
        } else {
            book.withdrawLiquidity(amount, lp);
        }
        _assertSolvent();
        _settle(m, 1); // worst case for the house
        vm.prank(alice);
        book.claim(1);
        _assertSolvent();
    }
}
