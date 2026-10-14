import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import { BetSlipDock } from "@/components/bet-slip";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "FairPlay — transparent on-chain sports markets (testnet demo)",
  description: "On-chain sports markets with transparent rules, verifiable settlement, and testnet payouts. Demonstration MVP — no real money.",
};

export const viewport: Viewport = { themeColor: "#0a0c0f", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh">
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6 lg:px-8">{children}</main>
          <Footer />
          <BetSlipDock />
        </Providers>
      </body>
    </html>
  );
}
