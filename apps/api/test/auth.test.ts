import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, BETTOR, createHarness, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("wallet-signature authentication", () => {
  it("issues a single-use, expiring SIWE-style challenge", async () => {
    const address = h.wallet(ADMIN).account.address;
    const r = await h.app.inject({ method: "GET", url: `/api/auth/nonce?address=${address}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.message).toContain("localhost:3600 wants you to sign in");
    expect(body.message).toContain(address);
    expect(body.message).toContain(`Nonce: ${body.nonce}`);
    expect(body.message).toContain("Chain ID: 31337");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const stored = await h.ctx.db.authNonce.findUnique({ where: { nonce: body.nonce } });
    expect(stored?.usedAt).toBeNull();
  });

  it("logs in an address holding an admin role on-chain", async () => {
    const { res } = await h.login(ADMIN);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.roles).toContain("DEFAULT_ADMIN_ROLE");
    expect(body.roles).toContain("MARKET_MANAGER_ROLE");
    const me = await h.adminCall(body.token, "GET", "/api/admin/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().address).toBe(h.wallet(ADMIN).account.address.toLowerCase());
  });

  it("rejects a replayed signature", async () => {
    const first = await h.login(ADMIN);
    expect(first.res.statusCode).toBe(200);
    const replay = await h.app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { address: first.address, message: first.message, signature: first.signature },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.message).toMatch(/replay/);
  });

  it("rejects concurrent replays — exactly one wins", async () => {
    const address = h.wallet(ADMIN).account.address;
    const { message } = (await h.app.inject({ method: "GET", url: `/api/auth/nonce?address=${address}` })).json();
    const signature = await h.wallet(ADMIN).signMessage({ message });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { address, message, signature } })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(4);
  });

  it("rejects an expired nonce", async () => {
    const address = h.wallet(ADMIN).account.address;
    const { message, nonce } = (await h.app.inject({ method: "GET", url: `/api/auth/nonce?address=${address}` })).json();
    await h.ctx.db.authNonce.update({ where: { nonce }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const signature = await h.wallet(ADMIN).signMessage({ message });
    const r = await h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { address, message, signature } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toMatch(/expired/);
  });

  it("rejects a signature from a different wallet", async () => {
    const address = h.wallet(ADMIN).account.address;
    const { message } = (await h.app.inject({ method: "GET", url: `/api/auth/nonce?address=${address}` })).json();
    const signature = await h.wallet(BETTOR).signMessage({ message }); // wrong signer
    const r = await h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { address, message, signature } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toMatch(/invalid signature/);
  });

  it("rejects a tampered message", async () => {
    const address = h.wallet(ADMIN).account.address;
    const { message } = (await h.app.inject({ method: "GET", url: `/api/auth/nonce?address=${address}` })).json();
    const tampered = message.replace("Chain ID: 31337", "Chain ID: 1");
    const signature = await h.wallet(ADMIN).signMessage({ message: tampered });
    const r = await h.app.inject({ method: "POST", url: "/api/auth/verify", payload: { address, message: tampered, signature } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toMatch(/does not match/);
  });

  it("refuses a valid signature from an address without an on-chain admin role", async () => {
    const { res } = await h.login(BETTOR);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("NOT_ADMIN");
    expect(await h.ctx.db.adminSession.count({ where: { address: h.wallet(BETTOR).account.address.toLowerCase() } })).toBe(0);
  });

  it("revokes the session on logout", async () => {
    const { token } = await h.login(ADMIN);
    const out = await h.app.inject({ method: "DELETE", url: "/api/auth/session", headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(204);
    const me = await h.adminCall(token!, "GET", "/api/admin/me");
    expect(me.statusCode).toBe(401);
  });

  it("validates input", async () => {
    const r = await h.app.inject({ method: "GET", url: "/api/auth/nonce?address=0xnotanaddress" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("VALIDATION_ERROR");
  });
});
