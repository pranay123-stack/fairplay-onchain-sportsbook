// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BettingMarket} from "../src/BettingMarket.sol";
import {MockOracleAdapter} from "../src/MockOracleAdapter.sol";
import {IOracleAdapter} from "../src/interfaces/IOracleAdapter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

abstract contract BaseTest is Test {
    MockUSDC internal usdc;
    BettingMarket internal book;
    MockOracleAdapter internal oracle;

    address internal admin = makeAddr("admin");
    address internal manager = makeAddr("manager");
    address internal oddsBot = makeAddr("oddsBot");
    address internal lp = makeAddr("lp");
    address internal reporter = makeAddr("reporter");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint16 internal constant FEE_BPS = 200; // 2% of winnings
    uint64 internal constant FINALITY = 10 minutes;
    uint256 internal constant HOUSE = 100_000e6;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC(admin);
        book = new BettingMarket(usdc, admin, FEE_BPS);
        oracle = new MockOracleAdapter(admin, FINALITY);

        vm.startPrank(admin);
        book.grantRole(book.MARKET_MANAGER_ROLE(), manager);
        book.grantRole(book.ODDS_MANAGER_ROLE(), oddsBot);
        book.grantRole(book.LIQUIDITY_MANAGER_ROLE(), lp);
        book.grantRole(book.TREASURY_ROLE(), treasury);
        book.grantRole(book.PAUSER_ROLE(), admin);
        book.setOracleAllowed(address(oracle), true);
        oracle.grantRole(oracle.REPORTER_ROLE(), reporter);
        usdc.mint(lp, 10_000_000e6);
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        usdc.mint(carol, 1_000_000e6);
        vm.stopPrank();

        _approve(lp);
        _approve(alice);
        _approve(bob);
        _approve(carol);
        _depositHouse(HOUSE);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _approve(address who) internal {
        vm.prank(who);
        usdc.approve(address(book), type(uint256).max);
    }

    function _depositHouse(uint256 amount) internal {
        vm.prank(lp);
        book.depositLiquidity(amount);
    }

    function _odds3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory o) {
        o = new uint256[](3);
        (o[0], o[1], o[2]) = (a, b, c);
    }

    function _odds2(uint256 a, uint256 b) internal pure returns (uint256[] memory o) {
        o = new uint256[](2);
        (o[0], o[1]) = (a, b);
    }

    function _newEvent(uint64 startsIn) internal returns (uint256 eventId) {
        vm.prank(manager);
        eventId = book.createEvent(keccak256(abi.encode("event", block.timestamp, startsIn)), uint64(block.timestamp) + startsIn);
    }

    function _newMarket(uint256 eventId, uint256[] memory odds, uint256 maxLiability) internal returns (uint256 id) {
        BettingMarket.MarketParams memory p = BettingMarket.MarketParams({
            eventId: eventId,
            ref: keccak256(abi.encode("market", eventId, odds.length, block.number)),
            outcomeCount: uint8(odds.length),
            initialOdds: odds,
            minStake: 1e6,
            maxStake: 50_000e6,
            maxLiability: maxLiability,
            oracle: oracle
        });
        vm.startPrank(manager);
        id = book.createMarket(p);
        book.openMarket(id);
        vm.stopPrank();
    }

    /// 1X2 market: home 2.50 / draw 3.40 / away 2.80, kick-off in 1 day.
    function _defaultMarket() internal returns (uint256) {
        return _newMarket(_newEvent(1 days), _odds3(25_000, 34_000, 28_000), 1_000_000e6);
    }

    function _bet(address who, uint256 marketId, uint256 outcome, uint256 stake) internal returns (uint256 id) {
        uint256 odds = book.getOutcome(marketId, outcome).odds;
        vm.prank(who);
        id = book.placeBet(marketId, outcome, stake, odds);
    }

    /// Pass kick-off, report a winner, wait out the finality window and settle.
    function _settle(uint256 marketId, uint8 winner) internal {
        BettingMarket.Market memory m = book.getMarket(marketId);
        if (block.timestamp < m.closeTime) vm.warp(m.closeTime + 2 hours);
        vm.prank(reporter);
        oracle.reportResult(m.questionId, winner, "test");
        vm.warp(block.timestamp + FINALITY);
        book.settleMarket(marketId);
    }

    function _assertSolvent() internal view {
        (uint256 required, uint256 held) = book.solvency();
        assertGe(held, required, "escrow conservation");
        assertGe(book.houseBalance(), book.totalReserved(), "liability coverage");
    }
}
