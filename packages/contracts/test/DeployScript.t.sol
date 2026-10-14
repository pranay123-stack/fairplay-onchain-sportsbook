// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {BettingMarket} from "../src/BettingMarket.sol";

/// Exercises the real deployment script's safety checks for a public network (chain id set to Sepolia).
contract DeployScriptTest is Test {
    uint256 constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address constant ANVIL_ADDR_7 = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955;

    uint256 deployerKey = uint256(keccak256("fresh deployer (test only)"));
    address operator = makeAddr("fresh operator");
    address reporter = makeAddr("fresh reporter");

    Deploy script;

    function setUp() public {
        vm.chainId(11155111);
        vm.deal(vm.addr(deployerKey), 1 ether);
        script = new Deploy();
    }

    function _cfg() internal view returns (Deploy.Config memory) {
        return Deploy.Config({
            deployerKey: deployerKey,
            deployer: vm.addr(deployerKey),
            operator: operator,
            reporter: reporter,
            feeBps: 200,
            finality: 120,
            liquidity: 0,
            out: "cache/deploy-script-test.json"
        });
    }

    function test_refusesAnvilDeployerKeyOffLocalChain() public {
        Deploy.Config memory c = _cfg();
        c.deployerKey = ANVIL_KEY_0;
        c.deployer = vm.addr(ANVIL_KEY_0);
        vm.deal(c.deployer, 1 ether);
        vm.expectRevert("Deploy: deployer is a public Anvil dev account");
        script.deploy(c);
    }

    function test_refusesAnvilOperatorAndReporter() public {
        Deploy.Config memory c = _cfg();
        c.operator = ANVIL_ADDR_7;
        vm.expectRevert("Deploy: operator is a public Anvil dev account");
        script.deploy(c);
        c = _cfg();
        c.reporter = ANVIL_ADDR_7;
        vm.expectRevert("Deploy: reporter is a public Anvil dev account");
        script.deploy(c);
    }

    function test_requiresDistinctRoles() public {
        Deploy.Config memory c = _cfg();
        c.reporter = operator;
        vm.expectRevert("Deploy: use three distinct addresses");
        script.deploy(c);
    }

    function test_requiresFundedDeployer() public {
        vm.deal(vm.addr(deployerKey), 0);
        vm.expectRevert("Deploy: deployer has no ETH for gas");
        script.deploy(_cfg());
    }

    function test_localChainAllowsAnvilAccounts() public {
        vm.chainId(31337);
        Deploy.Config memory c = _cfg();
        c.deployerKey = ANVIL_KEY_0;
        c.deployer = vm.addr(ANVIL_KEY_0);
        c.out = "cache/deploy-script-test-local.json";
        BettingMarket book = script.deploy(c);
        assertTrue(address(book) != address(0));
    }

    function test_freshAccountsDeployAndWireRolesWithLiquidity() public {
        Deploy.Config memory c = _cfg();
        c.liquidity = 50_000e6;
        BettingMarket book = script.deploy(c);
        string memory json = vm.readFile("cache/deploy-script-test.json");
        assertEq(vm.parseJsonAddress(json, ".bettingMarket"), address(book));
        assertEq(vm.parseJsonUint(json, ".chainId"), 11155111);
        assertTrue(book.hasRole(book.MARKET_MANAGER_ROLE(), operator));
        assertTrue(book.hasRole(book.ODDS_MANAGER_ROLE(), operator));
        assertTrue(book.hasRole(book.DEFAULT_ADMIN_ROLE(), vm.addr(deployerKey)));
        assertFalse(book.hasRole(book.LIQUIDITY_MANAGER_ROLE(), operator));
        assertEq(book.houseBalance(), 50_000e6);
        (uint256 required, uint256 held) = book.solvency();
        assertEq(required, held);
    }
}
