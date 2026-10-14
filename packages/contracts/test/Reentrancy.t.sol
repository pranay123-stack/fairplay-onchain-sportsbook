// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BettingMarket} from "../src/BettingMarket.sol";
import {MockOracleAdapter} from "../src/MockOracleAdapter.sol";

/// ERC-777-style token that calls back into the recipient on every transfer — the classic reentrancy vector.
contract HookToken is ERC20 {
    constructor() ERC20("Hook", "HOOK") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length > 0 && from != address(0)) {
            try IHookReceiver(to).onTokenReceived(from, value) {} catch {}
        }
    }
}

interface IHookReceiver {
    function onTokenReceived(address from, uint256 value) external;
}

contract Attacker is IHookReceiver {
    BettingMarket public immutable book;
    uint256 public betId;
    uint256 public marketId;
    uint256 public attempts;
    bytes public lastRevert;

    constructor(BettingMarket book_) {
        book = book_;
    }

    function setTarget(uint256 marketId_, uint256 betId_) external {
        marketId = marketId_;
        betId = betId_;
    }

    function approve(HookToken t) external {
        t.approve(address(book), type(uint256).max);
    }

    function bet(uint256 m, uint256 stake, uint256 odds) external returns (uint256) {
        return book.placeBet(m, 0, stake, odds);
    }

    function claim() external returns (uint256) {
        return book.claim(betId);
    }

    /// On receiving the payout, try to claim again (and to bet again) inside the same call.
    function onTokenReceived(address, uint256) external {
        if (msg.sender != address(book.collateral())) return;
        attempts++;
        try book.claim(betId) {} catch (bytes memory err) {
            lastRevert = err;
        }
    }
}

contract ReentrancyTest is Test {
    HookToken token;
    BettingMarket book;
    MockOracleAdapter oracle;
    Attacker attacker;
    address admin = makeAddr("admin");

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new HookToken();
        book = new BettingMarket(token, admin, 0);
        oracle = new MockOracleAdapter(admin, 0);
        vm.startPrank(admin);
        book.grantRole(book.MARKET_MANAGER_ROLE(), admin);
        book.grantRole(book.LIQUIDITY_MANAGER_ROLE(), admin);
        book.setOracleAllowed(address(oracle), true);
        oracle.grantRole(oracle.REPORTER_ROLE(), admin);
        vm.stopPrank();

        token.mint(admin, 1_000_000e6);
        vm.startPrank(admin);
        token.approve(address(book), type(uint256).max);
        book.depositLiquidity(100_000e6);
        vm.stopPrank();

        attacker = new Attacker(book);
        token.mint(address(attacker), 1_000e6);
        attacker.approve(token);
    }

    function test_reentrantClaim_isBlocked() public {
        vm.startPrank(admin);
        uint256 ev = book.createEvent(bytes32("e"), uint64(block.timestamp + 1 hours));
        uint256[] memory odds = new uint256[](2);
        (odds[0], odds[1]) = (20_000, 20_000);
        uint256 m = book.createMarket(
            BettingMarket.MarketParams({
                eventId: ev,
                ref: bytes32("m"),
                outcomeCount: 2,
                initialOdds: odds,
                minStake: 1,
                maxStake: 1e12,
                maxLiability: 1e12,
                oracle: oracle
            })
        );
        book.openMarket(m);
        vm.stopPrank();

        uint256 id = attacker.bet(m, 100e6, 20_000);
        attacker.setTarget(m, id);

        vm.warp(block.timestamp + 2 hours);
        bytes32 q = book.getMarket(m).questionId;
        vm.prank(admin);
        oracle.reportResult(q, 0, "test");
        book.settleMarket(m);

        uint256 before = token.balanceOf(address(attacker));
        attacker.claim();

        // Paid exactly once, and the nested claim hit the reentrancy guard.
        assertEq(token.balanceOf(address(attacker)), before + 200e6);
        assertEq(attacker.attempts(), 1);
        assertEq(bytes4(attacker.lastRevert()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        (uint256 required, uint256 held) = book.solvency();
        assertEq(required, held);
    }
}
