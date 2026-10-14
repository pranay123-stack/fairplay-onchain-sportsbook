import {
  type Abi,
  type Account,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { bettingMarketAbi, mockUsdcAbi, oracleAdapterAbi } from "@fairplay/shared";
import type { Db } from "./db.ts";
import type { Env } from "./env.ts";
import type { Logger } from "./logger.ts";

export const anvilLocal = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8565"] } },
});

export function chainFor(env: Env): Chain {
  if (env.CHAIN_ID === sepolia.id) return { ...sepolia, rpcUrls: { default: { http: [env.RPC_URL] } } };
  return { ...anvilLocal, id: env.CHAIN_ID, rpcUrls: { default: { http: [env.RPC_URL] } } };
}

export interface Contracts {
  bettingMarket: { address: Hex; abi: typeof bettingMarketAbi };
  mockUSDC: { address: Hex; abi: typeof mockUsdcAbi };
  oracleAdapter: { address: Hex; abi: typeof oracleAdapterAbi };
}

export interface ChainCtx {
  chain: Chain;
  publicClient: PublicClient;
  contracts: Contracts;
  operator: TxSender;
  reporter: TxSender;
  labelOf(address: string | null | undefined): string | null;
}

export class TxError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly txHash?: Hex,
  ) {
    super(message);
  }
}

/** Extracts the contract's custom-error name (e.g. "InsufficientLiquidity") from a viem error. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    }
    return err.shortMessage;
  }
  return (err as Error)?.message ?? String(err);
}

/**
 * Sends transactions for one backend service key, strictly one at a time (so nonces never collide between
 * the odds engine, the keeper and admin actions), simulating first so reverts surface as named errors
 * BEFORE anything is broadcast. Every submitted transaction is recorded in the `Transaction` table.
 */
export class TxSender {
  private queue: Promise<unknown> = Promise.resolve();
  readonly wallet: WalletClient;
  readonly account: Account;

  constructor(
    readonly service: "operator" | "oracle",
    privateKey: Hex,
    private readonly chain: Chain,
    rpcUrl: string,
    private readonly publicClient: PublicClient,
    private readonly db: Db,
    private readonly log: Logger,
    private readonly txTimeoutMs = 60_000,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
  }

  get address(): Hex {
    return this.account.address;
  }

  send<
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, "nonpayable" | "payable">,
    args extends ContractFunctionArgs<abi, "nonpayable" | "payable", functionName>,
  >(req: {
    kind: string;
    address: Hex;
    abi: abi;
    functionName: functionName;
    args: args;
    marketId?: string;
    timeoutMs?: number;
    /** Runs right after broadcast, before waiting for the receipt (e.g. to link a pending row to its hash). */
    onSubmitted?: (hash: Hex) => Promise<void>;
  }): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
    const run = async () => {
      let hash: Hex;
      try {
        const { request } = await this.publicClient.simulateContract({
          account: this.account,
          address: req.address,
          abi: req.abi as Abi,
          functionName: req.functionName as string,
          args: req.args as readonly unknown[],
          chain: this.chain,
        });
        hash = await this.wallet.writeContract(request as never);
      } catch (err) {
        const reason = revertReason(err);
        this.log.warn({ service: this.service, kind: req.kind, reason }, "transaction rejected in simulation");
        throw new TxError(`${req.kind} would revert: ${reason}`, reason);
      }
      await this.db.transaction.create({
        data: {
          hash,
          kind: req.kind,
          service: this.service,
          from: this.address.toLowerCase(),
          to: req.address.toLowerCase(),
          status: "SUBMITTED",
          marketId: req.marketId ?? null,
        },
      });
      if (req.onSubmitted) await req.onSubmitted(hash);
      try {
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash,
          timeout: req.timeoutMs ?? this.txTimeoutMs,
        });
        const ok = receipt.status === "success";
        await this.db.transaction.update({
          where: { hash },
          data: {
            status: ok ? "CONFIRMED" : "REVERTED",
            blockNumber: Number(receipt.blockNumber),
            confirmedAt: new Date(),
          },
        });
        if (!ok) throw new TxError(`${req.kind} reverted on-chain`, "reverted", hash);
        this.log.info({ service: this.service, kind: req.kind, hash, block: Number(receipt.blockNumber) }, "tx confirmed");
        return { hash, receipt };
      } catch (err) {
        if (err instanceof TxError) throw err;
        await this.db.transaction.update({ where: { hash }, data: { status: "TIMEOUT", error: revertReason(err) } });
        throw new TxError(`${req.kind} not confirmed: ${revertReason(err)}`, "timeout", hash);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function createChainCtx(env: Env, db: Db, log: Logger): ChainCtx {
  const chain = chainFor(env);
  // cacheTime 0: the indexer and keeper must never act on a cached (stale) head.
  const publicClient = createPublicClient({ chain, transport: http(env.RPC_URL, { retryCount: 3 }), pollingInterval: env.RPC_POLLING_MS, cacheTime: 0 }) as PublicClient;
  const d = env.deployment;
  const contracts: Contracts = {
    bettingMarket: { address: d.bettingMarket, abi: bettingMarketAbi },
    mockUSDC: { address: d.mockUSDC, abi: mockUsdcAbi },
    oracleAdapter: { address: d.oracleAdapter, abi: oracleAdapterAbi },
  };
  const labels = new Map<string, string>([
    [d.bettingMarket.toLowerCase(), "BettingMarket"],
    [d.mockUSDC.toLowerCase(), "MockUSDC"],
    [d.oracleAdapter.toLowerCase(), "MockOracleAdapter"],
    [d.operator.toLowerCase(), "Operator service"],
    [d.reporter.toLowerCase(), "Mock oracle reporter"],
    [d.deployer.toLowerCase(), "Deployer / admin"],
  ]);
  return {
    chain,
    publicClient,
    contracts,
    operator: new TxSender("operator", env.OPERATOR_PRIVATE_KEY as Hex, chain, env.RPC_URL, publicClient, db, log, env.TX_TIMEOUT_MS),
    reporter: new TxSender("oracle", env.ORACLE_REPORTER_PRIVATE_KEY as Hex, chain, env.RPC_URL, publicClient, db, log, env.TX_TIMEOUT_MS),
    labelOf: (a) => (a ? (labels.get(a.toLowerCase()) ?? null) : null),
  };
}
