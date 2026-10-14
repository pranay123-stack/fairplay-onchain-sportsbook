"use client";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAccount } from "wagmi";
import { IS_LOCAL, NETWORK_LABEL } from "@/lib/env";
import { useRealtime } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { FaucetButton, WalletButton } from "./wallet-panel";

const NAV = [
  { href: "/", label: "Explore Markets" },
  { href: "/my-bets", label: "My Bets" },
  { href: "/transparency", label: "Transparency" },
  { href: "/admin", label: "Admin" },
];

export function Header() {
  const pathname = usePathname();
  const { isConnected } = useAccount();
  const { connected, head } = useRealtime();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/events") : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="border-b border-line/60 bg-warn-dim/40">
        <p className="mx-auto max-w-7xl px-4 py-1.5 text-center text-[11px] text-warn sm:px-6 lg:px-8">
          <span className="mr-2 rounded border border-warn/40 px-1.5 py-0.5 font-mono text-[10px]" data-testid="network-badge">
            {NETWORK_LABEL}
          </span>
          {IS_LOCAL ? "Local demonstration" : "Public testnet demonstration"} · fictional fixtures · valueless mUSDC · admin-controlled mock oracle
        </p>
      </div>
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="shrink-0" aria-label="FairPlay home">
          <Logo />
        </Link>
        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn("rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-fg", active(n.href) && "bg-surface-2 text-fg")}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span
            className="hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-muted lg:inline-flex"
            title={connected ? "Live updates connected" : "Live updates disconnected"}
            data-testid="chain-status"
          >
            <span className={cn("size-1.5 rounded-full", connected ? "bg-accent animate-pulse" : "bg-danger")} />
            {head ? `block ${head.head}` : "connecting"}
          </span>
          {isConnected ? (
            <div className="hidden sm:block">
              <FaucetButton compact />
            </div>
          ) : null}
          <WalletButton />
          <button className="rounded-md p-2 text-muted hover:text-fg md:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu">
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      {open ? (
        <nav className="border-t border-line px-4 py-3 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={cn("block rounded-md px-3 py-2.5 text-sm text-muted", active(n.href) && "bg-surface-2 text-fg")}>
              {n.label}
            </Link>
          ))}
          {isConnected ? (
            <div className="mt-2 px-3">
              <FaucetButton compact />
            </div>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}
