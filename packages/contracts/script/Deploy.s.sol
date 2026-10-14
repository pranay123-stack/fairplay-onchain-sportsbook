// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BettingMarket} from "../src/BettingMarket.sol";
import {MockOracleAdapter} from "../src/MockOracleAdapter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Deploys MockUSDC, MockOracleAdapter and BettingMarket, wires every role, optionally seeds house
///         liquidity, asserts the wiring on-chain, and writes deployments/<chainId>.json for the API and frontend.
///
/// Deployer key — EITHER:
///   DEPLOYER_PRIVATE_KEY   raw key (local Anvil only, in practice), OR
///   DEPLOYER_ADDRESS       + `forge script … --account <keystore-name>` (recommended on Sepolia: the key stays
///                          in Foundry's encrypted keystore and never appears in an env file)
/// Env:
///   OPERATOR_ADDRESS        backend operator service (MARKET_MANAGER + ODDS_MANAGER)
///   REPORTER_ADDRESS        mock oracle reporter service (REPORTER_ROLE on the adapter)
///   FEE_BPS                 platform fee on winnings, default 200 (2%)
///   ORACLE_FINALITY_SECONDS dispute window, default 10
///   HOUSE_LIQUIDITY         whole mUSDC to mint to the deployer and deposit as house liquidity, default 0
///   DEPLOYMENT_OUT          output path, default deployments/<chainId>.json
///
/// Off the local chain (31337) the script refuses Anvil's 10 public development accounts for every role,
/// requires three distinct addresses, and checks the deployer is funded — all BEFORE broadcasting.
contract Deploy is Script {
    function _isAnvilDevAccount(address a) internal pure returns (bool) {
        return a == 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 || a == 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
            || a == 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC || a == 0x90F79bf6EB2c4f870365E785982E1f101E93b906
            || a == 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 || a == 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
            || a == 0x976EA74026E726554dB657fA54763abd0C3a0aa9 || a == 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
            || a == 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f || a == 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;
    }

    struct Config {
        uint256 deployerKey; // 0 ⇒ broadcast as `deployer` via `--account` (encrypted keystore)
        address deployer;
        address operator;
        address reporter;
        uint16 feeBps;
        uint64 finality;
        uint256 liquidity; // base units (6 decimals)
        string out;
    }

    /// Reads the environment, then deploys. All logic lives in `deploy` so it can be tested without env vars.
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        deploy(
            Config({
                deployerKey: pk,
                deployer: pk != 0 ? vm.addr(pk) : vm.envAddress("DEPLOYER_ADDRESS"),
                operator: vm.envAddress("OPERATOR_ADDRESS"),
                reporter: vm.envAddress("REPORTER_ADDRESS"),
                feeBps: uint16(vm.envOr("FEE_BPS", uint256(200))),
                finality: uint64(vm.envOr("ORACLE_FINALITY_SECONDS", uint256(10))),
                liquidity: vm.envOr("HOUSE_LIQUIDITY", uint256(0)) * 1e6,
                out: vm.envOr(
                    "DEPLOYMENT_OUT", string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json")
                )
            })
        );
    }

    function deploy(Config memory c) public returns (BettingMarket book) {
        address deployer = c.deployer;
        address operator = c.operator;
        address reporter = c.reporter;
        uint16 feeBps = c.feeBps;
        uint64 finality = c.finality;
        uint256 liquidity = c.liquidity;

        if (block.chainid != 31337) {
            require(!_isAnvilDevAccount(deployer), "Deploy: deployer is a public Anvil dev account");
            require(!_isAnvilDevAccount(operator), "Deploy: operator is a public Anvil dev account");
            require(!_isAnvilDevAccount(reporter), "Deploy: reporter is a public Anvil dev account");
            require(deployer != operator && deployer != reporter && operator != reporter, "Deploy: use three distinct addresses");
            require(deployer.balance > 0, "Deploy: deployer has no ETH for gas");
        }

        if (c.deployerKey != 0) vm.startBroadcast(c.deployerKey);
        else vm.startBroadcast(deployer);
        MockUSDC usdc = new MockUSDC(deployer);
        MockOracleAdapter oracle = new MockOracleAdapter(deployer, finality);
        book = new BettingMarket(usdc, deployer, feeBps);

        book.grantRole(book.MARKET_MANAGER_ROLE(), deployer);
        book.grantRole(book.PAUSER_ROLE(), deployer);
        book.grantRole(book.TREASURY_ROLE(), deployer);
        book.grantRole(book.LIQUIDITY_MANAGER_ROLE(), deployer);
        book.grantRole(book.MARKET_MANAGER_ROLE(), operator);
        book.grantRole(book.ODDS_MANAGER_ROLE(), operator);
        book.setOracleAllowed(address(oracle), true);
        oracle.grantRole(oracle.REPORTER_ROLE(), reporter);
        if (liquidity > 0) {
            usdc.mint(deployer, liquidity);
            usdc.approve(address(book), liquidity);
            book.depositLiquidity(liquidity);
        }
        vm.stopBroadcast();

        // Assert the wiring on-chain rather than trusting the transactions above.
        require(book.hasRole(book.MARKET_MANAGER_ROLE(), operator), "operator role");
        require(book.hasRole(book.ODDS_MANAGER_ROLE(), operator), "odds role");
        require(oracle.hasRole(oracle.REPORTER_ROLE(), reporter), "reporter role");
        require(book.allowedOracle(address(oracle)), "oracle allow-list");
        require(book.houseBalance() == liquidity, "house liquidity");

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "operator", operator);
        vm.serializeAddress(k, "reporter", reporter);
        vm.serializeAddress(k, "mockUSDC", address(usdc));
        vm.serializeAddress(k, "oracleAdapter", address(oracle));
        vm.serializeUint(k, "feeBps", feeBps);
        vm.serializeUint(k, "oracleFinalitySeconds", finality);
        string memory json = vm.serializeAddress(k, "bettingMarket", address(book));
        string memory path = c.out;
        // Persist addresses ONLY when they really exist on-chain (broadcast/resume) or in tests. A dry-run
        // simulation must never leave a deployment file pointing at contracts that were never deployed.
        bool persist = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)
            || vm.isContext(VmSafe.ForgeContext.TestGroup);
        if (persist) vm.writeJson(json, path);
        else path = "(not written: simulation only)";

        console2.log("MockUSDC        ", address(usdc));
        console2.log("MockOracleAdapter", address(oracle));
        console2.log("BettingMarket   ", address(book));
        console2.log("written to      ", path);
    }
}
