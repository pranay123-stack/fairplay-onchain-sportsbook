"use client";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useAppConfig } from "@/lib/api";
import { cn, shortHash } from "@/lib/utils";

/** Links to the in-app transaction inspector (decoded from the chain), plus a public explorer when one exists. */
export function TxLink({ hash, className, label }: { hash?: string | null; className?: string; label?: string }) {
  const { data: cfg } = useAppConfig();
  if (!hash) return <span className="text-faint">—</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs", className)}>
      <Link href={`/tx/${hash}`} className="text-accent-bright underline-offset-2 hover:underline">
        {label ?? shortHash(hash)}
      </Link>
      {cfg?.explorerUrl ? (
        <a href={`${cfg.explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer" className="text-muted hover:text-fg" aria-label="Open in block explorer">
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </span>
  );
}
