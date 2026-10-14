import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { Logger } from "./logger.ts";

/** Thin wrapper so services can emit without caring whether Socket.IO is attached (tests, CLI). */
export class Realtime {
  private io: Server | null = null;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];

  constructor(private readonly log: Logger) {}

  attach(server: HttpServer, origins: string[]) {
    this.io = new Server(server, { cors: { origin: origins, methods: ["GET"] }, serveClient: false });
    this.io.on("connection", (socket) => {
      this.log.debug({ id: socket.id }, "socket connected");
      // Clients may scope themselves to one wallet's notifications; nothing private is ever sent.
      socket.on("subscribe:wallet", (address: unknown) => {
        if (typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)) {
          void socket.join(`wallet:${address.toLowerCase()}`);
        }
      });
    });
    return this.io;
  }

  emit(event: string, payload: unknown, wallet?: string) {
    this.emitted.push({ event, payload });
    if (this.emitted.length > 500) this.emitted.splice(0, this.emitted.length - 500);
    if (!this.io) return;
    this.io.emit(event, payload);
    if (wallet) this.io.to(`wallet:${wallet.toLowerCase()}`).emit(`wallet:${event}`, payload);
  }

  async close() {
    await this.io?.close();
  }
}
