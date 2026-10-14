// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IOracleAdapter} from "./interfaces/IOracleAdapter.sol";

/// @title BettingMarket — fixed-odds sports markets with fully collateralised house liability.
///
/// @notice Solvency model (see docs/SMART_CONTRACTS.md for the proof sketch):
///   * The house (liquidity provider) is the counterparty to every bet and pre-funds `houseBalance`.
///   * For each market m, with per-outcome gross payouts G_i and total stake S, the worst-case amount the
///     house can lose is R_m = max(0, max_i G_i - S). Losing stakes in the same market net against
///     winners, because a market settles atomically to exactly one outcome (or refunds everything).
///   * `totalReserved` = Σ R_m over unsettled markets, and the contract enforces
///         totalReserved <= houseBalance                                   (liability coverage)
///     on every bet and every liquidity withdrawal.
///   * Every token the contract holds belongs to exactly one bucket:
///         balance >= houseBalance + openStake + outstandingClaims + accruedFees  (escrow conservation)
///   Together these guarantee that every winning claim and every refund can be paid.
///
/// @dev Odds are fixed-point with ODDS_SCALE = 1e4 (2.5000 → 25_000). All maths is integer; every
///      division rounds down, i.e. in favour of the contract's solvency, never the bettor's quote.
contract BettingMarket is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────── roles ───────────────────────────────────────────
    bytes32 public constant MARKET_MANAGER_ROLE = keccak256("MARKET_MANAGER_ROLE");
    bytes32 public constant ODDS_MANAGER_ROLE = keccak256("ODDS_MANAGER_ROLE");
    bytes32 public constant LIQUIDITY_MANAGER_ROLE = keccak256("LIQUIDITY_MANAGER_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ───────────────────────────────────────── constants ─────────────────────────────────────────
    uint256 public constant ODDS_SCALE = 1e4;
    uint256 public constant MIN_ODDS = 10_100; // 1.01
    uint256 public constant MAX_ODDS = 1_000_000; // 100.00
    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 1_000; // 10% of winnings, hard ceiling
    uint8 public constant MIN_OUTCOMES = 2;
    uint8 public constant MAX_OUTCOMES = 8;

    // ─────────────────────────────────────────── types ───────────────────────────────────────────
    enum MarketStatus {
        Pending, // created, not yet accepting bets
        Open, // accepting bets (until closeTime)
        Closed, // betting stopped, awaiting a final oracle result
        Settled, // winner known; winners may claim
        Cancelled // voided; every stake may be refunded
    }

    enum BetStatus {
        None,
        Open, // market not yet settled/cancelled
        Won, // claimable payout
        Lost,
        Refundable, // market cancelled, stake claimable
        Claimed // payout or refund already paid
    }

    struct SportEvent {
        bytes32 ref; // keccak of the off-chain metadata id (names live off-chain)
        uint64 startTime; // kick-off; betting on all of its markets closes here
        uint32 marketCount;
    }

    struct Market {
        uint256 eventId;
        bytes32 ref;
        bytes32 questionId; // key under which the oracle reports this market's result
        IOracleAdapter oracle; // fixed at creation; cannot be swapped once bets exist
        MarketStatus status;
        uint8 outcomeCount;
        uint8 winningOutcome;
        uint16 feeBps; // fee snapshot — later fee changes never affect existing markets
        uint64 closeTime;
        uint64 closedAt; // effective close time (<= closeTime)
        uint64 settledAt;
        uint32 oddsVersion;
        uint64 createdAt; // oracle reports older than the market itself are never consumed (review F-1)
        uint256 minStake;
        uint256 maxStake;
        uint256 maxLiability; // cap on R_m for this market
        uint256 totalStake; // S
        uint256 reserved; // current R_m (0 once settled/cancelled)
    }

    struct OutcomeBook {
        uint256 odds; // current executable odds for NEW bets
        uint256 stake; // Σ stake on this outcome
        uint256 grossPayout; // Σ stake * lockedOdds
        uint256 netPayout; // Σ potentialPayout (gross minus fee)
        uint32 betCount;
    }

    struct Bet {
        uint256 id;
        address bettor;
        uint256 marketId;
        uint256 outcomeId;
        uint256 stake;
        uint256 odds; // locked at placement
        uint256 potentialPayout; // net amount paid if this outcome wins (stake + profit - fee)
        bool claimed;
    }

    struct MarketParams {
        uint256 eventId;
        bytes32 ref;
        uint8 outcomeCount;
        uint256[] initialOdds;
        uint256 minStake;
        uint256 maxStake;
        uint256 maxLiability;
        IOracleAdapter oracle;
    }

    // ─────────────────────────────────────────── state ───────────────────────────────────────────
    IERC20 public immutable collateral;

    uint16 public feeBps;

    /// @notice LP capital: free + reserved. Moves only on deposit/withdraw and on settlement.
    uint256 public houseBalance;
    /// @notice Σ R_m over unsettled markets — house capital that cannot be withdrawn.
    uint256 public totalReserved;
    /// @notice Stakes of bets in markets that are neither settled nor cancelled.
    uint256 public openStake;
    /// @notice Settled winnings + refunds owed to bettors and not yet claimed.
    uint256 public outstandingClaims;
    /// @notice Platform fees withheld from winnings, withdrawable by TREASURY_ROLE.
    uint256 public accruedFees;

    uint256 public eventCount;
    uint256 public marketCount;
    uint256 public betCount;

    mapping(uint256 => SportEvent) private _events;
    mapping(uint256 => Market) private _markets;
    mapping(uint256 => mapping(uint256 => OutcomeBook)) private _books;
    mapping(uint256 => Bet) private _bets;
    mapping(address => uint256[]) private _betsByBettor;
    mapping(address => bool) public allowedOracle;

    // ─────────────────────────────────────────── events ──────────────────────────────────────────
    event SportEventCreated(uint256 indexed eventId, bytes32 indexed ref, uint64 startTime);
    event MarketCreated(
        uint256 indexed marketId,
        uint256 indexed eventId,
        bytes32 indexed ref,
        bytes32 questionId,
        address oracle,
        uint8 outcomeCount,
        uint64 closeTime,
        uint16 feeBps,
        uint256[] odds
    );
    event MarketLimits(uint256 indexed marketId, uint256 minStake, uint256 maxStake, uint256 maxLiability);
    event MarketStatusChanged(uint256 indexed marketId, MarketStatus status, uint64 at);
    event OddsUpdated(uint256 indexed marketId, uint32 version, uint256[] odds);
    event BetPlaced(
        uint256 indexed betId,
        uint256 indexed marketId,
        address indexed bettor,
        uint256 outcomeId,
        uint256 stake,
        uint256 odds,
        uint256 potentialPayout
    );
    event MarketSettled(
        uint256 indexed marketId,
        uint8 winningOutcome,
        uint256 totalStake,
        uint256 winnersPayout,
        uint256 fees,
        int256 houseDelta,
        address oracleReporter,
        uint64 resultReportedAt
    );
    event MarketCancelled(uint256 indexed marketId, uint256 refundTotal, string reason);
    event PayoutClaimed(uint256 indexed betId, address indexed bettor, uint256 amount, bool refund);
    event LiquidityDeposited(address indexed from, uint256 amount, uint256 houseBalance);
    event LiquidityWithdrawn(address indexed to, uint256 amount, uint256 houseBalance);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event FeeBpsSet(uint16 feeBps);
    event OracleAllowed(address indexed oracle, bool allowed);

    // ─────────────────────────────────────────── errors ──────────────────────────────────────────
    error UnknownEvent(uint256 eventId);
    error UnknownMarket(uint256 marketId);
    error UnknownBet(uint256 betId);
    error InvalidStatus(uint256 marketId, MarketStatus status);
    error InvalidOutcomeCount(uint8 count);
    error InvalidOutcome(uint256 outcomeId);
    error InvalidOdds(uint256 odds);
    error OddsChanged(uint256 expected, uint256 current);
    error StakeOutOfRange(uint256 stake, uint256 min, uint256 max);
    error InvalidStakeLimits();
    error StartTimeInPast(uint64 startTime);
    error BettingClosed(uint256 marketId, uint64 closeTime);
    error TooEarlyToClose(uint256 marketId, uint64 closeTime);
    error InsufficientLiquidity(uint256 required, uint256 available);
    error MarketLiabilityCapExceeded(uint256 liability, uint256 cap);
    error OracleNotAllowed(address oracle);
    error ResultNotFinal(bytes32 questionId);
    error ResultPredatesClose(uint64 reportedAt, uint64 closedAt);
    error ResultPredatesMarket(uint64 reportedAt, uint64 createdAt);
    error ResultAlreadyFinal(uint256 marketId);
    error ResultPending(uint256 marketId);
    error InvalidResult(uint8 winningOutcome);
    error NotBettor(uint256 betId);
    error NothingToClaim(uint256 betId, BetStatus status);
    error AmountExceedsFree(uint256 amount, uint256 free);
    error FeeTooHigh(uint16 feeBps);
    error TransferShortfall(uint256 expected, uint256 received);
    error ZeroAmount();
    error ZeroAddress();

    constructor(IERC20 collateral_, address admin, uint16 feeBps_) {
        if (address(collateral_) == address(0) || admin == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        collateral = collateral_;
        feeBps = feeBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit FeeBpsSet(feeBps_);
    }

    // ═══════════════════════════════════════ admin config ════════════════════════════════════════

    function setOracleAllowed(address oracle, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (oracle == address(0)) revert ZeroAddress();
        allowedOracle[oracle] = allowed;
        emit OracleAllowed(oracle, allowed);
    }

    /// @notice Applies to markets created afterwards only.
    function setFeeBps(uint16 feeBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        feeBps = feeBps_;
        emit FeeBpsSet(feeBps_);
    }

    /// @notice Pausing stops new bets, new liquidity and settlement. Claims of already-settled
    ///         markets and refunds of cancelled ones are never paused — bettors can always exit.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ══════════════════════════════════════ events & markets ═════════════════════════════════════

    function createEvent(bytes32 ref, uint64 startTime) external onlyRole(MARKET_MANAGER_ROLE) returns (uint256 id) {
        if (startTime <= block.timestamp) revert StartTimeInPast(startTime);
        id = ++eventCount;
        _events[id] = SportEvent({ref: ref, startTime: startTime, marketCount: 0});
        emit SportEventCreated(id, ref, startTime);
    }

    function createMarket(MarketParams calldata p) external onlyRole(MARKET_MANAGER_ROLE) returns (uint256 id) {
        SportEvent storage ev = _events[p.eventId];
        if (ev.startTime == 0) revert UnknownEvent(p.eventId);
        if (ev.startTime <= block.timestamp) revert StartTimeInPast(ev.startTime);
        if (p.outcomeCount < MIN_OUTCOMES || p.outcomeCount > MAX_OUTCOMES) revert InvalidOutcomeCount(p.outcomeCount);
        if (p.initialOdds.length != p.outcomeCount) revert InvalidOutcomeCount(uint8(p.initialOdds.length));
        if (p.minStake == 0 || p.maxStake < p.minStake) revert InvalidStakeLimits();
        if (!allowedOracle[address(p.oracle)]) revert OracleNotAllowed(address(p.oracle));

        id = ++marketCount;
        ev.marketCount += 1;
        Market storage m = _markets[id];
        m.eventId = p.eventId;
        m.ref = p.ref;
        m.questionId = keccak256(abi.encode(block.chainid, address(this), id));
        m.oracle = p.oracle;
        m.status = MarketStatus.Pending;
        m.outcomeCount = p.outcomeCount;
        m.feeBps = feeBps;
        m.closeTime = ev.startTime;
        m.minStake = p.minStake;
        m.maxStake = p.maxStake;
        m.maxLiability = p.maxLiability;
        m.oddsVersion = 1;
        m.createdAt = uint64(block.timestamp);
        for (uint256 i; i < p.outcomeCount; ++i) {
            _checkOdds(p.initialOdds[i]);
            _books[id][i].odds = p.initialOdds[i];
        }
        emit MarketCreated(
            id,
            p.eventId,
            p.ref,
            m.questionId,
            address(p.oracle),
            p.outcomeCount,
            m.closeTime,
            m.feeBps,
            p.initialOdds
        );
        emit MarketLimits(id, p.minStake, p.maxStake, p.maxLiability);
        emit MarketStatusChanged(id, MarketStatus.Pending, uint64(block.timestamp));
    }

    function openMarket(uint256 marketId) external onlyRole(MARKET_MANAGER_ROLE) {
        Market storage m = _market(marketId);
        if (m.status != MarketStatus.Pending) revert InvalidStatus(marketId, m.status);
        if (block.timestamp >= m.closeTime) revert BettingClosed(marketId, m.closeTime);
        _setStatus(marketId, m, MarketStatus.Open);
    }

    /// @notice Stop accepting bets. The manager may close early (e.g. suspend on news); anyone may close
    ///         a market whose closeTime has passed.
    function closeMarket(uint256 marketId) external {
        Market storage m = _market(marketId);
        if (m.status != MarketStatus.Open) revert InvalidStatus(marketId, m.status);
        if (block.timestamp < m.closeTime && !hasRole(MARKET_MANAGER_ROLE, msg.sender)) {
            revert TooEarlyToClose(marketId, m.closeTime);
        }
        _close(marketId, m);
    }

    /// @notice Resume a market the manager closed early, as long as kick-off has not passed and the oracle
    ///         has not reported anything for it.
    function reopenMarket(uint256 marketId) external onlyRole(MARKET_MANAGER_ROLE) {
        Market storage m = _market(marketId);
        if (m.status != MarketStatus.Closed) revert InvalidStatus(marketId, m.status);
        if (block.timestamp >= m.closeTime) revert BettingClosed(marketId, m.closeTime);
        if (m.oracle.getResult(m.questionId).status != IOracleAdapter.ResultStatus.None) {
            revert ResultPending(marketId);
        }
        m.closedAt = 0;
        _setStatus(marketId, m, MarketStatus.Open);
    }

    /// @notice Update the executable odds for NEW bets. Existing bets keep their locked odds.
    function setOdds(uint256 marketId, uint256[] calldata newOdds) external onlyRole(ODDS_MANAGER_ROLE) {
        Market storage m = _market(marketId);
        if (m.status != MarketStatus.Pending && m.status != MarketStatus.Open) revert InvalidStatus(marketId, m.status);
        if (newOdds.length != m.outcomeCount) revert InvalidOutcomeCount(uint8(newOdds.length));
        for (uint256 i; i < newOdds.length; ++i) {
            _checkOdds(newOdds[i]);
            _books[marketId][i].odds = newOdds[i];
        }
        m.oddsVersion += 1;
        emit OddsUpdated(marketId, m.oddsVersion, newOdds);
    }

    /// @notice Void a market and refund every stake. Not allowed once the oracle has a FINAL "resolved"
    ///         result: a final outcome must be honoured, it cannot be cancelled away.
    function cancelMarket(uint256 marketId, string calldata reason) external onlyRole(MARKET_MANAGER_ROLE) {
        Market storage m = _market(marketId);
        MarketStatus s = m.status;
        if (s == MarketStatus.Settled || s == MarketStatus.Cancelled) revert InvalidStatus(marketId, s);
        // A result that settleMarket would accept must be honoured. Anything else (no result, a result still
        // in its dispute window, an out-of-range winner, a winner reported before betting closed) leaves the
        // market cancellable — otherwise such a market could never settle AND never refund: stakes locked.
        if (_isSettleableResult(m)) revert ResultAlreadyFinal(marketId);
        _cancel(marketId, m, reason);
    }

    // ═══════════════════════════════════════════ betting ═════════════════════════════════════════

    /// @param expectedOdds the odds the bettor saw; the bet reverts if the executable odds differ.
    function placeBet(uint256 marketId, uint256 outcomeId, uint256 stake, uint256 expectedOdds)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        Market storage m = _market(marketId);
        if (m.status != MarketStatus.Open) revert InvalidStatus(marketId, m.status);
        if (block.timestamp >= m.closeTime) revert BettingClosed(marketId, m.closeTime);
        if (outcomeId >= m.outcomeCount) revert InvalidOutcome(outcomeId);
        if (stake < m.minStake || stake > m.maxStake) revert StakeOutOfRange(stake, m.minStake, m.maxStake);

        OutcomeBook storage book = _books[marketId][outcomeId];
        uint256 odds = book.odds;
        if (odds != expectedOdds) revert OddsChanged(expectedOdds, odds);

        (uint256 gross,, uint256 net) = _payout(stake, odds, m.feeBps);

        // ── liability check (effects computed before any external call) ──
        uint256 newTotalStake = m.totalStake + stake;
        uint256 newReserved = _worstCase(marketId, m.outcomeCount, outcomeId, book.grossPayout + gross, newTotalStake);
        if (newReserved > m.maxLiability) revert MarketLiabilityCapExceeded(newReserved, m.maxLiability);
        uint256 newTotalReserved = totalReserved - m.reserved + newReserved;
        if (newTotalReserved > houseBalance) {
            revert InsufficientLiquidity(newTotalReserved, houseBalance);
        }

        // ── effects ──
        book.stake += stake;
        book.grossPayout += gross;
        book.netPayout += net;
        book.betCount += 1;
        m.totalStake = newTotalStake;
        m.reserved = newReserved;
        totalReserved = newTotalReserved;
        openStake += stake;

        betId = ++betCount;
        _bets[betId] = Bet({
            id: betId,
            bettor: msg.sender,
            marketId: marketId,
            outcomeId: outcomeId,
            stake: stake,
            odds: odds,
            potentialPayout: net,
            claimed: false
        });
        _betsByBettor[msg.sender].push(betId);
        emit BetPlaced(betId, marketId, msg.sender, outcomeId, stake, odds, net);

        // ── interaction ──
        _pull(msg.sender, stake);
    }

    // ══════════════════════════════════════════ settlement ═══════════════════════════════════════

    /// @notice Settle a closed market from its oracle's FINAL result. Permissionless: authority comes from
    ///         the oracle adapter fixed at market creation (which itself enforces who may report).
    function settleMarket(uint256 marketId) external nonReentrant whenNotPaused {
        Market storage m = _market(marketId);
        if (m.status == MarketStatus.Settled || m.status == MarketStatus.Cancelled) {
            revert InvalidStatus(marketId, m.status);
        }
        if (!m.oracle.isFinal(m.questionId)) revert ResultNotFinal(m.questionId);
        IOracleAdapter.OracleResult memory r = m.oracle.getResult(m.questionId);

        // A final cancellation (postponed / abandoned fixture) voids the market at any stage, as long as it
        // was reported after the market existed. questionIds are predictable, so without that check a
        // cancellation filed in advance could void a future market at will (review finding F-1).
        if (r.status == IOracleAdapter.ResultStatus.Cancelled) {
            if (r.reportedAt < m.createdAt) revert ResultPredatesMarket(r.reportedAt, m.createdAt);
            _cancel(marketId, m, "oracle: fixture cancelled");
            return;
        }

        if (m.status == MarketStatus.Open && block.timestamp >= m.closeTime) {
            _close(marketId, m); // kick-off passed: close implicitly at closeTime
        }
        if (m.status != MarketStatus.Closed) revert InvalidStatus(marketId, m.status);
        // A winner reported before betting closed could only be a pre-arranged one — never accept it.
        if (r.reportedAt < m.closedAt) revert ResultPredatesClose(r.reportedAt, m.closedAt);
        if (r.winningOutcome >= m.outcomeCount) revert InvalidResult(r.winningOutcome);

        OutcomeBook storage w = _books[marketId][r.winningOutcome];
        uint256 s = m.totalStake;
        uint256 fees = w.grossPayout - w.netPayout;
        // House receives every losing stake and pays every winner's gross profit:
        //   houseDelta = (S - stake_w) - (G_w - stake_w) = S - G_w  >=  -R_m  (so it can never underflow)
        houseBalance = houseBalance + s - w.grossPayout;
        totalReserved -= m.reserved;
        openStake -= s;
        outstandingClaims += w.netPayout;
        accruedFees += fees;

        m.reserved = 0;
        m.winningOutcome = r.winningOutcome;
        m.settledAt = uint64(block.timestamp);
        m.status = MarketStatus.Settled;

        emit MarketSettled(
            marketId,
            r.winningOutcome,
            s,
            w.netPayout,
            fees,
            int256(s) - int256(w.grossPayout),
            r.reporter,
            r.reportedAt
        );
        emit MarketStatusChanged(marketId, MarketStatus.Settled, uint64(block.timestamp));
    }

    /// @notice Pay a winning bet, or refund a bet in a cancelled market. Never paused.
    function claim(uint256 betId) external nonReentrant returns (uint256 amount) {
        amount = _claim(betId);
    }

    function claimMany(uint256[] calldata betIds) external nonReentrant returns (uint256 total) {
        for (uint256 i; i < betIds.length; ++i) {
            total += _claim(betIds[i]);
        }
    }

    // ══════════════════════════════════════ liquidity & fees ═════════════════════════════════════

    function depositLiquidity(uint256 amount) external nonReentrant whenNotPaused onlyRole(LIQUIDITY_MANAGER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        houseBalance += amount;
        emit LiquidityDeposited(msg.sender, amount, houseBalance);
        _pull(msg.sender, amount);
    }

    /// @notice Withdraw only capital that does not back an open liability.
    function withdrawLiquidity(uint256 amount, address to) external nonReentrant onlyRole(LIQUIDITY_MANAGER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeLiquidity();
        if (amount > free) revert AmountExceedsFree(amount, free);
        houseBalance -= amount;
        emit LiquidityWithdrawn(to, amount, houseBalance);
        collateral.safeTransfer(to, amount);
    }

    function withdrawFees(uint256 amount, address to) external nonReentrant onlyRole(TREASURY_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > accruedFees) revert AmountExceedsFree(amount, accruedFees);
        accruedFees -= amount;
        emit FeesWithdrawn(to, amount);
        collateral.safeTransfer(to, amount);
    }

    // ═════════════════════════════════════════════ views ═════════════════════════════════════════

    function freeLiquidity() public view returns (uint256) {
        return houseBalance - totalReserved;
    }

    /// @notice Tokens the contract must hold to honour every obligation, vs tokens it actually holds.
    function solvency() external view returns (uint256 required, uint256 held) {
        required = houseBalance + openStake + outstandingClaims + accruedFees;
        held = collateral.balanceOf(address(this));
    }

    function getEvent(uint256 eventId) external view returns (SportEvent memory) {
        return _events[eventId];
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function getOutcome(uint256 marketId, uint256 outcomeId) external view returns (OutcomeBook memory) {
        return _books[marketId][outcomeId];
    }

    function getOdds(uint256 marketId) external view returns (uint256[] memory odds) {
        uint8 n = _markets[marketId].outcomeCount;
        odds = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            odds[i] = _books[marketId][i].odds;
        }
    }

    function getBet(uint256 betId) external view returns (Bet memory) {
        return _bets[betId];
    }

    function getBetIds(address bettor) external view returns (uint256[] memory) {
        return _betsByBettor[bettor];
    }

    function betStatus(uint256 betId) public view returns (BetStatus) {
        Bet storage b = _bets[betId];
        if (b.bettor == address(0)) return BetStatus.None;
        if (b.claimed) return BetStatus.Claimed;
        Market storage m = _markets[b.marketId];
        if (m.status == MarketStatus.Cancelled) return BetStatus.Refundable;
        if (m.status != MarketStatus.Settled) return BetStatus.Open;
        return b.outcomeId == m.winningOutcome ? BetStatus.Won : BetStatus.Lost;
    }

    /// @notice Exactly what `placeBet` would lock right now, plus whether it would be accepted.
    function quote(uint256 marketId, uint256 outcomeId, uint256 stake)
        external
        view
        returns (uint256 odds, uint256 grossPayout, uint256 fee, uint256 netPayout, bool acceptable)
    {
        Market storage m = _markets[marketId];
        if (outcomeId >= m.outcomeCount) return (0, 0, 0, 0, false);
        odds = _books[marketId][outcomeId].odds;
        (grossPayout, fee, netPayout) = _payout(stake, odds, m.feeBps);
        acceptable = _acceptable(marketId, outcomeId, stake, grossPayout);
    }

    /// @notice Pure payout maths, shared with the off-chain quote in packages/shared.
    function computePayout(uint256 stake, uint256 odds, uint16 feeBps_)
        external
        pure
        returns (uint256 grossPayout, uint256 fee, uint256 netPayout)
    {
        return _payout(stake, odds, feeBps_);
    }

    // ═══════════════════════════════════════════ internal ════════════════════════════════════════

    function _market(uint256 marketId) private view returns (Market storage m) {
        m = _markets[marketId];
        if (m.outcomeCount == 0) revert UnknownMarket(marketId);
    }

    /// @dev True iff settleMarket would settle this market to a winner right now.
    function _isSettleableResult(Market storage m) private view returns (bool) {
        if (!m.oracle.isFinal(m.questionId)) return false;
        IOracleAdapter.OracleResult memory r = m.oracle.getResult(m.questionId);
        if (r.status != IOracleAdapter.ResultStatus.Resolved || r.winningOutcome >= m.outcomeCount) return false;
        uint64 effectiveClose;
        if (m.status == MarketStatus.Closed) effectiveClose = m.closedAt;
        else if (m.status == MarketStatus.Open && block.timestamp >= m.closeTime) effectiveClose = m.closeTime;
        else return false; // Pending, or still open before kick-off: cannot settle
        return r.reportedAt >= effectiveClose;
    }

    function _acceptable(uint256 marketId, uint256 outcomeId, uint256 stake, uint256 gross)
        private
        view
        returns (bool)
    {
        Market storage m = _markets[marketId];
        if (m.status != MarketStatus.Open || block.timestamp >= m.closeTime || paused()) return false;
        if (stake < m.minStake || stake > m.maxStake) return false;
        uint256 newReserved = _worstCase(
            marketId, m.outcomeCount, outcomeId, _books[marketId][outcomeId].grossPayout + gross, m.totalStake + stake
        );
        return newReserved <= m.maxLiability && totalReserved - m.reserved + newReserved <= houseBalance;
    }

    function _checkOdds(uint256 odds) private pure {
        if (odds < MIN_ODDS || odds > MAX_ODDS) revert InvalidOdds(odds);
    }

    function _setStatus(uint256 marketId, Market storage m, MarketStatus s) private {
        m.status = s;
        emit MarketStatusChanged(marketId, s, uint64(block.timestamp));
    }

    function _close(uint256 marketId, Market storage m) private {
        m.closedAt = block.timestamp < m.closeTime ? uint64(block.timestamp) : m.closeTime;
        m.status = MarketStatus.Closed;
        emit MarketStatusChanged(marketId, MarketStatus.Closed, m.closedAt);
    }

    function _cancel(uint256 marketId, Market storage m, string memory reason) private {
        uint256 s = m.totalStake;
        totalReserved -= m.reserved;
        openStake -= s;
        outstandingClaims += s;
        m.reserved = 0;
        m.settledAt = uint64(block.timestamp);
        m.status = MarketStatus.Cancelled;
        emit MarketCancelled(marketId, s, reason);
        emit MarketStatusChanged(marketId, MarketStatus.Cancelled, uint64(block.timestamp));
    }

    function _claim(uint256 betId) private returns (uint256 amount) {
        Bet storage b = _bets[betId];
        if (b.bettor == address(0)) revert UnknownBet(betId);
        if (b.bettor != msg.sender) revert NotBettor(betId);
        BetStatus st = betStatus(betId);
        bool refund;
        if (st == BetStatus.Won) {
            amount = b.potentialPayout;
        } else if (st == BetStatus.Refundable) {
            amount = b.stake;
            refund = true;
        } else {
            revert NothingToClaim(betId, st);
        }
        b.claimed = true;
        outstandingClaims -= amount;
        emit PayoutClaimed(betId, msg.sender, amount, refund);
        collateral.safeTransfer(msg.sender, amount);
    }

    /// @dev Pull exactly `amount`; rejects fee-on-transfer / rebasing behaviour that would break escrow.
    function _pull(address from, uint256 amount) private {
        uint256 before = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(from, address(this), amount);
        uint256 received = collateral.balanceOf(address(this)) - before;
        if (received != amount) revert TransferShortfall(amount, received);
    }

    /// @dev gross = floor(stake * odds / 1e4); fee = floor((gross - stake) * feeBps / 1e4); net = gross - fee.
    function _payout(uint256 stake, uint256 odds, uint16 feeBps_)
        private
        pure
        returns (uint256 gross, uint256 fee, uint256 net)
    {
        gross = stake * odds / ODDS_SCALE;
        // odds >= MIN_ODDS > ODDS_SCALE for live markets; guard anyway so a quote at odds 0 cannot underflow.
        uint256 profit = gross > stake ? gross - stake : 0;
        fee = profit * feeBps_ / BPS;
        net = gross - fee;
    }

    /// @dev R_m = max(0, max_i G_i - S), with outcome `changed` taking the hypothetical gross `changedGross`.
    function _worstCase(uint256 marketId, uint8 n, uint256 changed, uint256 changedGross, uint256 totalStake_)
        private
        view
        returns (uint256)
    {
        uint256 maxGross;
        for (uint256 i; i < n; ++i) {
            uint256 g = i == changed ? changedGross : _books[marketId][i].grossPayout;
            if (g > maxGross) maxGross = g;
        }
        return maxGross > totalStake_ ? maxGross - totalStake_ : 0;
    }
}
