import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AdminPrincipal } from "./auth/auth-service.ts";
import { TxError } from "./chain.ts";
import type { AppContext } from "./context.ts";
import { AppError } from "./errors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { publicRoutes } from "./routes/public.ts";

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminPrincipal;
  }
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    trustProxy: false,
    bodyLimit: 64 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (curl, tests, server-side rendering) send no Origin header.
      if (!origin || ctx.env.webOrigins.includes(origin)) return cb(null, true);
      cb(new AppError(403, "CORS_REJECTED", `origin ${origin} is not allowed`), false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(rateLimit, {
    max: ctx.env.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: { code: "RATE_LIMITED", message: `too many requests — retry in ${Math.ceil(c.ttl / 1000)}s` },
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "request validation failed", details: err.issues } });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof TxError) {
      return reply.status(422).send({ error: { code: "CHAIN_REJECTED", message: err.message, details: { reason: err.reason, txHash: err.txHash } } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send(err);
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "BAD_REQUEST", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "internal server error" } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: `no route ${req.method} ${req.url}` } }));

  await app.register(publicRoutes(ctx), { prefix: "/api" });
  await app.register(authRoutes(ctx), { prefix: "/api/auth" });
  await app.register(adminRoutes(ctx), { prefix: "/api/admin" });
  return app;
}
