// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MockUSDC — TESTNET-ONLY 6-decimal stablecoin stand-in.
/// @notice Has no value. Anyone can draw from the rate-limited faucet; privileged minting exists only so
///         the demo setup can seed liquidity. It must never be deployed to a production network.
contract MockUSDC is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 public faucetAmount = 1_000e6; // 1,000 mUSDC per drip
    uint256 public faucetCooldown = 1 hours;
    /// @notice Faucet refuses to drip to an account already holding at least this much.
    uint256 public faucetBalanceCap = 10_000e6;

    mapping(address => uint256) public lastDripAt;

    event FaucetDrip(address indexed to, uint256 amount);
    event FaucetConfigured(uint256 amount, uint256 cooldown, uint256 balanceCap);

    error FaucetCooldownActive(uint256 availableAt);
    error FaucetBalanceCapReached(uint256 balance, uint256 cap);

    constructor(address admin) ERC20("Mock USD Coin (testnet)", "mUSDC") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Privileged mint used only by the local demo setup to seed accounts and house liquidity.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Public, rate-limited test-token faucet.
    function faucet() external {
        uint256 last = lastDripAt[msg.sender];
        if (last != 0 && block.timestamp < last + faucetCooldown) {
            revert FaucetCooldownActive(last + faucetCooldown);
        }
        uint256 bal = balanceOf(msg.sender);
        if (bal >= faucetBalanceCap) revert FaucetBalanceCapReached(bal, faucetBalanceCap);
        lastDripAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
        emit FaucetDrip(msg.sender, faucetAmount);
    }

    /// @notice Seconds until `account` may use the faucet again (0 = available now).
    function faucetAvailableIn(address account) external view returns (uint256) {
        uint256 last = lastDripAt[account];
        if (last == 0 || block.timestamp >= last + faucetCooldown) return 0;
        return last + faucetCooldown - block.timestamp;
    }

    function configureFaucet(uint256 amount, uint256 cooldown, uint256 balanceCap)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        faucetAmount = amount;
        faucetCooldown = cooldown;
        faucetBalanceCap = balanceCap;
        emit FaucetConfigured(amount, cooldown, balanceCap);
    }
}
