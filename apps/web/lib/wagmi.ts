import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { defineChain } from "viem";
import { sepolia } from "viem/chains";
import { createConfig, http } from "wagmi";
import { DEV_ACCOUNTS } from "@fairplay/shared";
import { anvilDevWallet } from "./anvil-wallet";
import { CHAIN_ID, IS_LOCAL, RPC_URL, WALLETCONNECT_PROJECT_ID } from "./env";

export const anvil = defineChain({
  id: 31337,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

export const activeChain = CHAIN_ID === sepolia.id ? sepolia : anvil;

/**
 * The simulated "Anvil dev wallet" exists ONLY on the local chain. On Sepolia the user must connect a real
 * browser wallet (injected / MetaMask, or WalletConnect when a project id is configured) — there is no
 * fallback to the development wallet.
 */

const devWallets = IS_LOCAL
  ? [DEV_ACCOUNTS[3], DEV_ACCOUNTS[4], DEV_ACCOUNTS[0]].map((a) => anvilDevWallet({ address: a.address, label: a.label, index: a.index }, RPC_URL))
  : [];

const connectors = connectorsForWallets(
  [
    ...(IS_LOCAL ? [{ groupName: "Local demo (no extension needed)", wallets: devWallets }] : []),
    {
      groupName: "Browser wallets",
      wallets: WALLETCONNECT_PROJECT_ID ? [injectedWallet, metaMaskWallet, walletConnectWallet] : [injectedWallet],
    },
  ],
  { appName: "FairPlay (testnet demo)", projectId: WALLETCONNECT_PROJECT_ID || "fairplay-local-no-walletconnect" },
);

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors,
  transports: { [activeChain.id]: http(RPC_URL) } as never,
  ssr: true,
  pollingInterval: IS_LOCAL ? 1_000 : 4_000, // Sepolia blocks are ~12s; don't hammer a public RPC
});
