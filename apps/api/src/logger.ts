import pino from "pino";

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    base: { service: "fairplay-api" },
    redact: { paths: ["req.headers.authorization", "*.privateKey", "*.signature"], censor: "[redacted]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
  });
}
export type Logger = ReturnType<typeof createLogger>;
