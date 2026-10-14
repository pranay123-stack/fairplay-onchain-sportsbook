"use client";
import { darkTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Toaster } from "sonner";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <RainbowKitProvider
          theme={darkTheme({ accentColor: "#10b981", accentColorForeground: "#04130d", borderRadius: "medium", overlayBlur: "small" })}
          modalSize="compact"
          appInfo={{ appName: "FairPlay (testnet demo)", disclaimer: () => <p style={{ fontSize: 12 }}>Testnet tokens only. No real money.</p> }}
        >
          {children}
          <Toaster theme="dark" position="bottom-right" toastOptions={{ style: { background: "#161a20", border: "1px solid #232932", color: "#f4f6f8" } }} />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
