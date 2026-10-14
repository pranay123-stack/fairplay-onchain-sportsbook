import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Hex } from "viem";
import { z } from "zod";
import { cancelMarketSchema, createEventSchema, createMarketSchema, patchMarketSchema, resolveMarketSchema, uuidSchema } from "@fairplay/shared";
import type { AppContext } from "../context.ts";
import { AppError } from "../errors.ts";

const idParam = z.object({ id: uuidSchema });

export const adminRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    // Every admin route: valid session AND a live on-chain admin role (checked per request).
    app.addHook("preHandler", async (req) => {
      try {
        req.admin = await ctx.auth.authenticate(req.headers.authorization);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 403) {
          await ctx.db.adminAuditLog.create({
            data: { address: "unknown", action: `${req.method} ${req.routeOptions.url}`, params: {}, outcome: "DENIED", error: err.code, ip: req.ip },
          });
        }
        throw err;
      }
    });

    const audit = (req: FastifyRequest) => ({ address: req.admin!.address, ip: req.ip });

    app.get("/me", async (req) => ({ address: req.admin!.address, roles: req.admin!.roles }));

    app.post("/events", async (req, reply) => {
      const input = createEventSchema.parse(req.body);
      const { event, txHash } = await ctx.markets.createEvent(audit(req), input);
      return reply.status(201).send({ id: event.id, onchainId: event.onchainId, txHash });
    });

    app.post("/markets", async (req, reply) => {
      const input = createMarketSchema
        .extend({ simulateOdds: z.boolean().default(false), featured: z.boolean().default(false) })
        .parse(req.body);
      const r = await ctx.markets.createMarket(audit(req), input);
      return reply.status(201).send(r);
    });

    app.patch("/markets/:id", async (req) => {
      const { id } = idParam.parse(req.params);
      return ctx.markets.patchMarket(audit(req), id, patchMarketSchema.parse(req.body));
    });

    app.post("/markets/:id/close", async (req) => {
      const { id } = idParam.parse(req.params);
      return ctx.markets.closeMarket(audit(req), id);
    });

    /** Requires a fresh wallet signature over {winningOutcome, source} — see POST /api/auth/action-nonce. */
    app.post("/markets/:id/resolve", async (req) => {
      const { id } = idParam.parse(req.params);
      const body = resolveMarketSchema.parse(req.body);
      await ctx.auth.consumeActionSignature(
        req.admin!,
        "resolve",
        id,
        { winningOutcome: body.winningOutcome, source: body.source },
        body.nonce,
        body.signature as Hex,
      );
      return ctx.markets.resolve(audit(req), id, body.winningOutcome, body.source);
    });

    /** Requires a fresh wallet signature over {reason, via}. */
    app.post("/markets/:id/cancel", async (req) => {
      const { id } = idParam.parse(req.params);
      const body = cancelMarketSchema.parse(req.body);
      await ctx.auth.consumeActionSignature(req.admin!, "cancel", id, { reason: body.reason, via: body.via }, body.nonce, body.signature as Hex);
      return ctx.markets.cancel(audit(req), id, body.reason, body.via);
    });

    app.post("/markets/:id/settle", async (req) => {
      const { id } = idParam.parse(req.params);
      const { hash } = await ctx.markets.settle(id);
      return { txHash: hash };
    });

    app.post("/markets/:id/simulate-odds", async (req) => {
      const { id } = idParam.parse(req.params);
      const moved = await ctx.oddsEngine.step(id);
      if (!moved) throw new AppError(409, "NOT_ELIGIBLE", "market is not open, starts within 90s, or already has a pending odds update");
      return { moved };
    });

    app.get("/odds-engine", async () => ({ enabled: ctx.oddsEngine.enabled, intervalSeconds: ctx.oddsEngine.intervalSeconds, simulated: true }));

    app.post("/odds-engine", async (req) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      ctx.oddsEngine.enabled = enabled;
      await ctx.db.adminAuditLog.create({
        data: { address: req.admin!.address, action: "ODDS_ENGINE", params: { enabled }, outcome: "OK", ip: req.ip },
      });
      return { enabled };
    });

    app.get("/audit-log", async () => {
      const rows = await ctx.db.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    });

    app.get("/transactions", async () => {
      const rows = await ctx.db.transaction.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), confirmedAt: r.confirmedAt?.toISOString() ?? null }));
    });
  };
