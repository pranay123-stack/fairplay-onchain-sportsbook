import type { FastifyPluginAsync } from "fastify";
import type { Hex } from "viem";
import { actionNonceSchema, authNonceQuerySchema, authVerifySchema } from "@fairplay/shared";
import type { AppContext } from "../context.ts";

export const authRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    // Tighter limit on the authentication surface.
    const limited = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

    app.get("/nonce", limited, async (req) => {
      const { address } = authNonceQuerySchema.parse(req.query);
      return ctx.auth.issueLoginNonce(address);
    });

    app.post("/verify", limited, async (req) => {
      const body = authVerifySchema.parse(req.body);
      return ctx.auth.verifyLogin(body.address, body.message, body.signature as Hex);
    });

    app.get("/session", async (req) => {
      const admin = await ctx.auth.authenticate(req.headers.authorization);
      return { address: admin.address, roles: admin.roles };
    });

    app.delete("/session", async (req, reply) => {
      const admin = await ctx.auth.authenticate(req.headers.authorization);
      await ctx.auth.logout(admin.sessionId);
      return reply.status(204).send();
    });

    /** Challenge for a high-impact action (resolve/cancel), bound to its exact parameters. */
    app.post("/action-nonce", limited, async (req) => {
      const admin = await ctx.auth.authenticate(req.headers.authorization);
      const body = actionNonceSchema.parse(req.body);
      return ctx.auth.issueActionNonce(admin, body.action, body.marketId, body.params);
    });
  };
