import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

const FRIENDLY: Record<string, string> = {
  OddsChanged: "The odds changed before your bet was mined. Review the new odds and try again — nothing was charged.",
  BettingClosed: "Betting on this market has closed (kick-off has passed).",
  InvalidStatus: "This market is not accepting that action in its current state.",
  InsufficientLiquidity: "The house does not have enough unreserved liquidity to cover this bet's potential payout. Try a smaller stake.",
  MarketLiabilityCapExceeded: "This bet would exceed the market's maximum liability. Try a smaller stake or another outcome.",
  StakeOutOfRange: "Stake is outside this market's minimum/maximum.",
  NothingToClaim: "There is nothing to claim for this bet (already claimed, lost, or not yet settled).",
  NotBettor: "Only the wallet that placed this bet can claim it.",
  FaucetCooldownActive: "The faucet is cooling down for this wallet. Try again later.",
  FaucetBalanceCapReached: "This wallet already holds enough mUSDC — the faucet has a balance cap.",
  EnforcedPause: "The contract is paused by the operator. Claims of settled bets still work.",
  ERC20InsufficientBalance: "Not enough mUSDC in this wallet. Use the faucet first.",
  ERC20InsufficientAllowance: "The betting contract is not approved to move this much mUSDC yet.",
  ResultNotFinal: "The oracle result is still inside its dispute window.",
};

export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet.";
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name && FRIENDLY[name]) return FRIENDLY[name]!;
      if (name) return `Rejected by the contract: ${name}`;
      return revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}
