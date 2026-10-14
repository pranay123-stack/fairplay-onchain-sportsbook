/**
 * ⚠ SIMULATED BROWSER WALLET for e2e tests (see wallet-injected.spec.ts for the rationale).
 * A scripted EIP-1193 provider installed as `window.ethereum`. It forwards JSON-RPC to the test chain, where
 * the node signs (unlocked or impersonated accounts) — no private key is ever placed in the page.
 */
import type { Page } from "@playwright/test";

/** Runs in the page before the app loads. */
export function installProvider({ rpc, account, chainId, appChainId }: { rpc: string; account: string; chainId: string; appChainId: string }) {
  type Listener = (v: unknown) => void;
  const listeners: Record<string, Listener[]> = {};
  const state = { account, chainId, authorised: false, rejectSign: false, rejectSend: false, holdSend: false, sendsRequested: 0 };
  let id = 0;
  const rpcCall = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
    return j.result;
  };
  const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
  const emit = (event: string, v: unknown) => (listeners[event] ?? []).forEach((cb) => cb(v));
  const provider = {
    isFairPlayTestWallet: true,
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_requestAccounts":
          state.authorised = true;
          return [state.account];
        case "eth_accounts": // like a real extension: nothing is exposed until the site is authorised
          return state.authorised ? [state.account] : [];
        case "eth_chainId":
          return state.chainId;
        case "net_version":
          return String(parseInt(state.chainId, 16));
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }];
        case "wallet_revokePermissions":
          state.authorised = false;
          return null;
        case "wallet_switchEthereumChain": {
          const target = (params[0] as { chainId: string }).chainId;
          // The simulated wallet can only "reach" the chain behind its RPC (the app's chain) or Ethereum mainnet
          // (which merely changes the reported id, to reproduce a wrong-network state).
          if (target !== appChainId && target !== "0x1") throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
          state.chainId = target;
          emit("chainChanged", target);
          return null;
        }
        case "personal_sign":
          if (state.rejectSign) throw rejected();
          return rpcCall(method, params);
        case "eth_sendTransaction": {
          state.sendsRequested++;
          while (state.holdSend) await new Promise((r) => setTimeout(r, 100));
          if (state.rejectSend) throw rejected();
          return rpcCall(method, [{ ...(params[0] as object), from: state.account }]);
        }
        default:
          return rpcCall(method, params);
      }
    },
    on(event: string, cb: Listener) {
      (listeners[event] ??= []).push(cb);
    },
    removeListener(event: string, cb: Listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
    },
  };
  (window as unknown as { ethereum: unknown }).ethereum = provider;
  (window as unknown as { __wallet: unknown }).__wallet = {
    state,
    switchAccount(a: string) {
      state.account = a;
      emit("accountsChanged", [a]);
    },
    switchChain(c: string) {
      state.chainId = c;
      emit("chainChanged", c);
    },
  };
}


export async function installSimulatedWallet(page: Page, opts: { rpc: string; account: string; chainId: string; appChainId: string }) {
  await page.addInitScript(installProvider, opts);
}

export const setWallet = (page: Page, patch: Record<string, boolean>) =>
  page.evaluate((p) => Object.assign((window as unknown as { __wallet: { state: object } }).__wallet.state, p), patch);

export const walletSwitchAccount = (page: Page, a: string) =>
  page.evaluate((x) => (window as unknown as { __wallet: { switchAccount(a: string): void } }).__wallet.switchAccount(x), a);

export const walletSwitchChain = (page: Page, c: string) =>
  page.evaluate((x) => (window as unknown as { __wallet: { switchChain(c: string): void } }).__wallet.switchChain(x), c);

export async function connectInjected(page: Page) {
  await page.getByTestId("connect-wallet").click();
  await page.getByRole("dialog").getByText(/Browser Wallet|Injected/).first().click();
}
