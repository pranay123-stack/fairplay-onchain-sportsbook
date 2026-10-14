import { AuthService } from "./auth/auth-service.ts";
import { createChainCtx } from "./chain.ts";
import type { AppContext } from "./context.ts";
import { createDb } from "./db.ts";
import { Keeper } from "./engine/keeper.ts";
import { OddsEngine } from "./engine/odds-engine.ts";
import type { Env } from "./env.ts";
import { Indexer } from "./indexer/indexer.ts";
import { Reconciler } from "./indexer/reconcile.ts";
import type { Logger } from "./logger.ts";
import { Realtime } from "./realtime.ts";
import { MarketService } from "./services/market-service.ts";

export function createContext(env: Env, log: Logger): AppContext & { keeper: Keeper } {
  const db = createDb(env.DATABASE_URL);
  const chain = createChainCtx(env, db, log);
  const realtime = new Realtime(log);
  const markets = new MarketService(db, chain, realtime, log);
  const indexer = new Indexer(db, chain, realtime, log.child({ module: "indexer" }), {
    confirmations: env.INDEXER_CONFIRMATIONS,
    batchBlocks: env.INDEXER_BATCH_BLOCKS,
    pollMs: env.INDEXER_POLL_MS,
    deployBlock: env.deployment.deployBlock,
    chainId: env.CHAIN_ID,
  });
  return {
    env,
    db,
    log,
    chain,
    realtime,
    markets,
    indexer,
    auth: new AuthService(db, chain, env),
    reconciler: new Reconciler(db, chain, log.child({ module: "reconcile" })),
    oddsEngine: new OddsEngine(db, markets, log.child({ module: "odds" }), [env.ODDS_ENGINE_MIN_SECONDS, env.ODDS_ENGINE_MAX_SECONDS], env.ODDS_ENGINE_ENABLED),
    keeper: new Keeper(db, chain, log.child({ module: "keeper" }), env.KEEPER_INTERVAL_MS),
  };
}
