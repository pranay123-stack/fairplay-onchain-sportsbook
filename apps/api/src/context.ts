import type { AuthService } from "./auth/auth-service.ts";
import type { ChainCtx } from "./chain.ts";
import type { Db } from "./db.ts";
import type { OddsEngine } from "./engine/odds-engine.ts";
import type { Env } from "./env.ts";
import type { Indexer } from "./indexer/indexer.ts";
import type { Reconciler } from "./indexer/reconcile.ts";
import type { Logger } from "./logger.ts";
import type { Realtime } from "./realtime.ts";
import type { MarketService } from "./services/market-service.ts";

export interface AppContext {
  env: Env;
  db: Db;
  log: Logger;
  chain: ChainCtx;
  realtime: Realtime;
  auth: AuthService;
  markets: MarketService;
  indexer: Indexer;
  reconciler: Reconciler;
  oddsEngine: OddsEngine;
}
