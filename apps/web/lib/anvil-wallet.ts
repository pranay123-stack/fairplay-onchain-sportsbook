/**
 * "Anvil dev wallet" — a wagmi connector for LOCAL DEMOS ONLY.
 *
 * It holds NO private key. Requests are forwarded to the local Anvil node, which has its well-known
 * development accounts unlocked and signs `eth_sendTransaction` / `personal_sign` itself. This lets a
 * reviewer click through the demo without installing a browser wallet, while keeping the frontend
 * key-free. It only exists when the app is configured for chain 31337, and is labelled as such in the UI.
 */
import type { Wallet } from "@rainbow-me/rainbowkit";
import { type Address, numberToHex } from "viem";
import { createConnector } from "wagmi";
import { IS_LOCAL } from "./env";

let rpcId = 0;
async function rpc(url: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  if (json.error) {
    const err = new Error(json.error.message) as Error & { code: number; data?: unknown };
    err.code = json.error.code;
    err.data = json.error.data;
    throw err;
  }
  return json.result;
}

const ICON =
  "data:image/svg+xml;base64," +
  (typeof btoa === "function"
    ? btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b3b2c"/><path d="M20 42 32 18l12 24" fill="none" stroke="#34d399" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M25 34h14" stroke="#34d399" stroke-width="5" stroke-linecap="round"/></svg>',
      )
    : "");

export function anvilDevWallet(account: { address: Address; label: string; index: number }, rpcUrl: string): () => Wallet {
  // Hard guard: this wallet must never exist outside the local chain (e.g. on Sepolia).
  if (!IS_LOCAL) throw new Error("The Anvil dev wallet is only available on the local chain (31337)");
  const id = `anvil-dev-${account.index}`;
  const chainHex = numberToHex(31337);
  const storageKey = `fairplay.${id}.connected`;

  return () => ({
    id,
    name: `Anvil dev · ${account.label}`,
    shortName: account.label,
    iconUrl: ICON,
    iconBackground: "#0b3b2c",
    installed: true,
    createConnector: (details) =>
      createConnector((config) => {
        const provider = {
          async request({ method, params }: { method: string; params?: unknown[] }) {
            switch (method) {
              case "eth_accounts":
              case "eth_requestAccounts":
                return [account.address];
              case "eth_chainId":
                return chainHex;
              case "wallet_switchEthereumChain": {
                const target = (params?.[0] as { chainId?: string })?.chainId;
                if (target !== chainHex) throw Object.assign(new Error("Anvil dev wallet only supports chain 31337"), { code: 4902 });
                return null;
              }
              case "eth_sendTransaction": {
                const tx = { ...(params?.[0] as Record<string, unknown>), from: account.address };
                return rpc(rpcUrl, method, [tx]);
              }
              default:
                return rpc(rpcUrl, method, params ?? []);
            }
          },
          on() {},
          removeListener() {},
        };
        return {
          ...details,
          id,
          name: `Anvil dev · ${account.label}`,
          type: "anvilDev",
          async connect(parameters?: { chainId?: number; isReconnecting?: boolean; withCapabilities?: boolean }) {
            if (parameters?.chainId && parameters.chainId !== 31337) throw new Error("Anvil dev wallet only supports chain 31337");
            try {
              localStorage.setItem(storageKey, "1");
            } catch {}
            config.emitter.emit("change", { accounts: [account.address], chainId: 31337 });
            return { accounts: [account.address], chainId: 31337 } as never;
          },
          async disconnect() {
            try {
              localStorage.removeItem(storageKey);
            } catch {}
          },
          async getAccounts() {
            return [account.address];
          },
          async getChainId() {
            return 31337;
          },
          async getProvider() {
            return provider;
          },
          async isAuthorized() {
            try {
              return localStorage.getItem(storageKey) === "1";
            } catch {
              return false;
            }
          },
          async switchChain({ chainId }: { chainId: number }) {
            const chain = config.chains.find((c) => c.id === chainId);
            if (!chain || chainId !== 31337) throw new Error("Anvil dev wallet only supports chain 31337");
            return chain;
          },
          onAccountsChanged() {},
          onChainChanged() {},
          onDisconnect() {
            config.emitter.emit("disconnect");
          },
        };
      }),
  });
}
