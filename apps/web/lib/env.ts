/**
 * Network selection is explicit: NEXT_PUBLIC_CHAIN_ID must be 31337 (local Anvil) or 11155111 (Sepolia).
 * Anything else fails the build/startup rather than silently falling back to the local demo.
 */
export const SUPPORTED_CHAINS = { anvil: 31337, sepolia: 11155111 } as const;

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4600";
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? SUPPORTED_CHAINS.anvil);
export const IS_LOCAL = CHAIN_ID === SUPPORTED_CHAINS.anvil;
export const IS_SEPOLIA = CHAIN_ID === SUPPORTED_CHAINS.sepolia;
if (!IS_LOCAL && !IS_SEPOLIA) {
  throw new Error(`NEXT_PUBLIC_CHAIN_ID=${CHAIN_ID} is not supported (use 31337 for Anvil or 11155111 for Sepolia)`);
}

/** Read RPC for the browser. On Sepolia this URL is PUBLIC (shipped to every visitor): never use a keyed URL. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? (IS_LOCAL ? "http://127.0.0.1:8565" : "https://ethereum-sepolia-rpc.publicnode.com");
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
export const NETWORK_LABEL = IS_LOCAL ? "Local Anvil" : "Sepolia testnet";
