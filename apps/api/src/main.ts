import { buildApp } from "./app.ts";
import { createContext } from "./bootstrap.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./logger.ts";

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === "development");
  const ctx = createContext(env, log);
  const app = await buildApp(ctx);
  ctx.realtime.attach(app.server, env.webOrigins);

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  log.info({ chainId: env.CHAIN_ID, bettingMarket: env.deployment.bettingMarket }, "FairPlay API ready");

  if (env.INDEXER_ENABLED) ctx.indexer.start();
  setTimeout(() => void ctx.reconciler.run().catch((err) => log.warn({ err }, "reconcile failed")), 3000);
  const reconcileTimer = setInterval(() => void ctx.reconciler.run().catch((err) => log.warn({ err }, "reconcile failed")), env.RECONCILE_INTERVAL_MS);
  if (env.KEEPER_ENABLED) ctx.keeper.start();
  ctx.oddsEngine.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    ctx.indexer.stop();
    ctx.keeper.stop();
    ctx.oddsEngine.stop();
    clearInterval(reconcileTimer);
    await ctx.realtime.close();
    await app.close();
    await ctx.db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
