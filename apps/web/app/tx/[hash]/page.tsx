"use client";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { use } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useTransaction } from "@/lib/api";
import { shortAddr } from "@/lib/utils";

/** A minimal block explorer for the local chain: everything here is read live from the node and decoded. */
export default function TxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = use(params);
  const { data: tx, error } = useTransaction(hash);
  if (error) return <p className="text-sm text-danger">Could not load transaction: {(error as Error).message}</p>;
  if (!tx) return <Skeleton className="h-80 w-full rounded-[var(--radius-card)]" />;

  return (
    <div className="mx-auto max-w-4xl space-y-5" data-testid="tx-page">
      <div>
        <p className="text-xs text-muted">Transaction · read live from the {tx.explorerUrl ? "network" : "local Anvil node"}</p>
        <h1 className="mt-1 break-all font-mono text-sm text-fg sm:text-base">{tx.hash}</h1>
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-5 text-sm sm:grid-cols-2">
          <Field label="Status">
            {tx.status === "success" ? (
              <Badge tone="accent" data-testid="tx-status">
                <CheckCircle2 className="size-3" /> Success
              </Badge>
            ) : tx.status === "reverted" ? (
              <Badge tone="danger" data-testid="tx-status">
                <XCircle className="size-3" /> Reverted
              </Badge>
            ) : (
              <Badge tone="warn" data-testid="tx-status">
                <Clock className="size-3" /> {tx.status === "pending" ? "Pending" : "Not found (yet)"}
              </Badge>
            )}
          </Field>
          <Field label="Confirmations">
            <span className="font-mono">{tx.confirmations}</span>
          </Field>
          <Field label="Block">
            <span className="font-mono">{tx.blockNumber ?? "—"}</span>
          </Field>
          <Field label="Timestamp">{tx.timestamp ? new Date(tx.timestamp).toLocaleString() : "—"}</Field>
          <Field label="From">
            <span className="font-mono">{shortAddr(tx.from, 8)}</span>
          </Field>
          <Field label="To">
            <span className="font-mono">{shortAddr(tx.to, 8)}</span> {tx.toLabel ? <Badge>{tx.toLabel}</Badge> : null}
          </Field>
          <Field label="Function">
            <span className="font-mono text-accent-bright">{tx.functionName ?? "—"}</span>
          </Field>
          <Field label="Gas used">
            <span className="font-mono">{tx.gasUsed ?? "—"}</span>
          </Field>
          {tx.explorerUrl ? (
            <Field label="Explorer">
              <a href={tx.explorerUrl} target="_blank" rel="noreferrer" className="text-accent-bright hover:underline">
                Open in block explorer
              </a>
            </Field>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Decoded events ({tx.decodedLogs.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {tx.decodedLogs.length === 0 ? <p className="text-xs text-muted">No events from FairPlay contracts.</p> : null}
          {tx.decodedLogs.map((l, i) => (
            <div key={i} className="rounded-lg border border-line bg-surface-2 p-3" data-testid="decoded-log">
              <p className="mb-2 text-sm">
                <span className="font-mono font-semibold text-accent-bright">{l.event}</span> <span className="text-xs text-muted">· {l.contract}</span>
              </p>
              <dl className="grid gap-1 text-xs">
                {Object.entries(l.args).map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[140px_1fr] gap-2">
                    <dt className="text-faint">{k}</dt>
                    <dd className="break-all font-mono">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-faint">{label}</p>
      <div className="mt-1 flex items-center gap-2">{children}</div>
    </div>
  );
}
