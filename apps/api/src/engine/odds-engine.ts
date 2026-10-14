import { ODDS_SCALE } from "@fairplay/shared";
import type { Db } from "../db.ts";
import type { Logger } from "../logger.ts";
import type { MarketService } from "../services/market-service.ts";

const MIN_DISPLAY_ODDS = 10_500; // 1.05
const MAX_DISPLAY_ODDS = 500_000; // 50.00
const TARGET_OVERROUND = 1.05; // a typical sportsbook margin: implied probabilities sum to 105%

/**
 * SIMULATED odds movement for demonstration markets. There is no external sports feed: this is a seeded
 * random walk on implied probabilities, clearly labelled "simulated" everywhere it is shown.
 *
 * Moves are proposals: they are written as PENDING, sent on-chain via `setOdds`, and only become the
 * executable odds once the indexer sees the confirmed `OddsUpdated` event. Bets already placed keep the
 * odds locked into them, and a bet sent against the old price reverts with `OddsChanged`.
 */
export function randomWalk(current: bigint[], rand: () => number = Math.random, maxMove = 0.06): bigint[] {
  const implied = current.map((o) => Number(ODDS_SCALE) / Number(o));
  const moved = implied.map((p) => Math.max(0.01, p * (1 + (rand() * 2 - 1) * maxMove)));
  const sum = moved.reduce((a, b) => a + b, 0);
  return moved.map((p) => {
    const odds = 1 / ((p / sum) * TARGET_OVERROUND);
    const cents = Math.round(odds * 100); // quote to 2 dp, i.e. a multiple of 100 in 1e4 units
    return BigInt(Math.min(MAX_DISPLAY_ODDS, Math.max(MIN_DISPLAY_ODDS, cents * 100)));
  });
}

export class OddsEngine {
  enabled: boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly markets: MarketService,
    private readonly log: Logger,
    readonly intervalSeconds: [number, number],
    enabled: boolean,
  ) {
    this.enabled = enabled;
  }

  start() {
    const schedule = () => {
      const [min, max] = this.intervalSeconds;
      const delay = (min + Math.random() * Math.max(0, max - min)) * 1000;
      this.timer = setTimeout(async () => {
        if (this.enabled) await this.step().catch((err) => this.log.warn({ err: (err as Error).message }, "odds engine step failed"));
        schedule();
      }, delay);
    };
    schedule();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Moves one eligible market. Returns the market id moved, or null. */
  async step(marketId?: string): Promise<string | null> {
    const soon = new Date(Date.now() + 90_000);
    const candidates = await this.db.market.findMany({
      where: {
        ...(marketId ? { id: marketId } : { simulateOdds: true }),
        status: "OPEN",
        closeTime: { gt: soon },
        oddsHistory: { none: { status: "PENDING" } },
      },
      include: { outcomes: { orderBy: { index: "asc" } } },
    });
    if (candidates.length === 0) return null;
    const m = candidates[Math.floor(Math.random() * candidates.length)]!;
    const next = randomWalk(m.outcomes.map((o) => BigInt(o.odds.toFixed(0))));
    if (next.every((o, i) => o.toString() === m.outcomes[i]!.odds.toFixed(0))) return null;
    await this.markets.proposeOdds(m.id, next, "simulated-engine");
    this.log.info({ market: m.onchainId, odds: next.map(String) }, "simulated odds move");
    return m.id;
  }
}
