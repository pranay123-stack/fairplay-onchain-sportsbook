import { createHash, randomBytes } from "node:crypto";
import { type Hex, keccak256, toHex } from "viem";
import { buildActionMessage } from "@fairplay/shared";
import type { ChainCtx } from "../chain.ts";
import type { Db } from "../db.ts";
import type { Env } from "../env.ts";
import { AppError, forbidden, unauthorized } from "../errors.ts";

export const ROLES = {
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
  MARKET_MANAGER_ROLE: keccak256(toHex("MARKET_MANAGER_ROLE")),
  ODDS_MANAGER_ROLE: keccak256(toHex("ODDS_MANAGER_ROLE")),
  LIQUIDITY_MANAGER_ROLE: keccak256(toHex("LIQUIDITY_MANAGER_ROLE")),
  TREASURY_ROLE: keccak256(toHex("TREASURY_ROLE")),
  PAUSER_ROLE: keccak256(toHex("PAUSER_ROLE")),
} as const;
export type RoleName = keyof typeof ROLES;

/** Holding either of these on the BettingMarket contract is what makes an address an admin. */
const ADMIN_ROLES: RoleName[] = ["DEFAULT_ADMIN_ROLE", "MARKET_MANAGER_ROLE"];
const ROLE_CACHE_MS = 5_000;

export interface AdminPrincipal {
  address: string;
  roles: RoleName[];
  sessionId: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class AuthService {
  private roleCache = new Map<string, { roles: RoleName[]; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly chain: ChainCtx,
    private readonly env: Env,
  ) {}

  /** Live on-chain roles. API authentication never substitutes for this check. */
  async onchainRoles(address: string, fresh = false): Promise<RoleName[]> {
    const key = address.toLowerCase();
    const hit = this.roleCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ROLE_CACHE_MS) return hit.roles;
    const { address: contract, abi } = this.chain.contracts.bettingMarket;
    const names = Object.keys(ROLES) as RoleName[];
    const has = await Promise.all(
      names.map((n) =>
        this.chain.publicClient.readContract({ address: contract, abi, functionName: "hasRole", args: [ROLES[n], address as Hex] }),
      ),
    );
    const roles = names.filter((_, i) => has[i]);
    this.roleCache.set(key, { roles, at: Date.now() });
    return roles;
  }

  isAdmin(roles: RoleName[]) {
    return roles.some((r) => ADMIN_ROLES.includes(r));
  }

  async issueLoginNonce(address: string) {
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + this.env.AUTH_NONCE_TTL_SECONDS * 1000);
    const message = [
      `${this.env.AUTH_DOMAIN} wants you to sign in with your Ethereum account:`,
      address,
      "",
      "Sign in to the FairPlay admin console. This signature does not move funds and grants no on-chain permission.",
      "",
      `URI: http://${this.env.AUTH_DOMAIN}`,
      "Version: 1",
      `Chain ID: ${this.env.CHAIN_ID}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
    ].join("\n");
    await this.db.authNonce.create({ data: { nonce, address: address.toLowerCase(), purpose: "login", message, expiresAt } });
    return { nonce, message, expiresAt: expiresAt.toISOString() };
  }

  /** Verifies a signed login message, consumes its nonce exactly once, and opens a session. */
  async verifyLogin(address: string, message: string, signature: Hex) {
    const nonce = /^Nonce: ([0-9a-f]{32})$/m.exec(message)?.[1];
    if (!nonce) throw unauthorized("malformed sign-in message");
    const rec = await this.db.authNonce.findUnique({ where: { nonce } });
    if (!rec || rec.purpose !== "login") throw unauthorized("unknown nonce");
    if (rec.address !== address.toLowerCase()) throw unauthorized("nonce was issued to a different address");
    if (rec.message !== message) throw unauthorized("message does not match the issued challenge");
    if (rec.usedAt) throw unauthorized("nonce already used (replay rejected)");
    if (rec.expiresAt.getTime() < Date.now()) throw unauthorized("nonce expired");

    const valid = await this.chain.publicClient.verifyMessage({ address: address as Hex, message, signature });
    if (!valid) throw unauthorized("invalid signature");

    // Atomic single use: concurrent replays of the same signature race here and only one wins.
    const consumed = await this.db.authNonce.updateMany({ where: { nonce, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw unauthorized("nonce already used (replay rejected)");

    const roles = await this.onchainRoles(address, true);
    if (!this.isAdmin(roles)) {
      throw forbidden("NOT_ADMIN", "signature valid, but this address holds no admin role on the BettingMarket contract");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.env.AUTH_SESSION_TTL_SECONDS * 1000);
    const session = await this.db.adminSession.create({
      data: { tokenHash: sha256(token), address: address.toLowerCase(), expiresAt },
    });
    return { token, address: address.toLowerCase(), roles, expiresAt: expiresAt.toISOString(), sessionId: session.id };
  }

  /** Resolves a bearer token to an admin, re-checking the on-chain role on every request. */
  async authenticate(authorization: string | undefined): Promise<AdminPrincipal> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
    if (!token) throw unauthorized();
    const session = await this.db.adminSession.findUnique({ where: { tokenHash: sha256(token) } });
    if (!session || session.revokedAt) throw unauthorized("invalid session");
    if (session.expiresAt.getTime() < Date.now()) throw unauthorized("session expired");
    const roles = await this.onchainRoles(session.address);
    if (!this.isAdmin(roles)) throw forbidden("ROLE_REVOKED", "this address no longer holds an admin role on-chain");
    return { address: session.address, roles, sessionId: session.id };
  }

  async logout(sessionId: string) {
    await this.db.adminSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  /** Issues a single-use challenge binding one high-impact action to its exact parameters. */
  async issueActionNonce(admin: AdminPrincipal, action: string, marketId: string, params: Record<string, string | number>) {
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + this.env.AUTH_NONCE_TTL_SECONDS * 1000).toISOString();
    const message = buildActionMessage({ domain: this.env.AUTH_DOMAIN, address: admin.address, action, marketId, params, nonce, expiresAt });
    await this.db.authNonce.create({
      data: { nonce, address: admin.address, purpose: "action", message, expiresAt: new Date(expiresAt) },
    });
    return { nonce, message, expiresAt };
  }

  /** Rebuilds the action message from the request itself, so a signature for other parameters fails. */
  async consumeActionSignature(
    admin: AdminPrincipal,
    action: string,
    marketId: string,
    params: Record<string, string | number>,
    nonce: string,
    signature: Hex,
  ) {
    const rec = await this.db.authNonce.findUnique({ where: { nonce } });
    if (!rec || rec.purpose !== "action") throw new AppError(401, "ACTION_SIGNATURE_INVALID", "unknown action nonce");
    if (rec.address !== admin.address) throw new AppError(401, "ACTION_SIGNATURE_INVALID", "nonce issued to another admin");
    if (rec.usedAt) throw new AppError(401, "ACTION_REPLAY", "action signature already used (replay rejected)");
    if (rec.expiresAt.getTime() < Date.now()) throw new AppError(401, "ACTION_SIGNATURE_EXPIRED", "action signature expired");
    const expected = buildActionMessage({
      domain: this.env.AUTH_DOMAIN,
      address: admin.address,
      action,
      marketId,
      params,
      nonce,
      expiresAt: rec.expiresAt.toISOString(),
    });
    if (expected !== rec.message) throw new AppError(401, "ACTION_SIGNATURE_INVALID", "signed parameters do not match this request");
    const valid = await this.chain.publicClient.verifyMessage({ address: admin.address as Hex, message: expected, signature });
    if (!valid) throw new AppError(401, "ACTION_SIGNATURE_INVALID", "invalid action signature");
    const consumed = await this.db.authNonce.updateMany({ where: { nonce, usedAt: null }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw new AppError(401, "ACTION_REPLAY", "action signature already used (replay rejected)");
  }
}
