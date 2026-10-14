import type { BetStatus, MarketLifecycle } from "@fairplay/shared";
import { Badge } from "@/components/ui/badge";

const MARKET: Record<MarketLifecycle, { label: string; tone: "neutral" | "accent" | "warn" | "danger" | "info" }> = {
  DRAFT: { label: "Confirming", tone: "neutral" },
  PENDING: { label: "Not open", tone: "neutral" },
  OPEN: { label: "Open", tone: "accent" },
  CLOSED: { label: "Closed · awaiting result", tone: "warn" },
  SETTLED: { label: "Settled", tone: "info" },
  CANCELLED: { label: "Cancelled · refunds", tone: "danger" },
};

export function MarketStatusBadge({ status }: { status: MarketLifecycle }) {
  const s = MARKET[status] ?? MARKET.DRAFT;
  return (
    <Badge tone={s.tone} data-testid="market-status">
      {status === "OPEN" ? <span className="size-1.5 rounded-full bg-accent-bright" /> : null}
      {s.label}
    </Badge>
  );
}

const BET: Record<BetStatus, { label: string; tone: "neutral" | "accent" | "warn" | "danger" | "info" }> = {
  NONE: { label: "Unknown", tone: "neutral" },
  OPEN: { label: "Open", tone: "neutral" },
  WON: { label: "Won · claimable", tone: "accent" },
  LOST: { label: "Lost", tone: "danger" },
  REFUNDABLE: { label: "Refund · claimable", tone: "warn" },
  CLAIMED: { label: "Paid out", tone: "info" },
};

export function BetStatusBadge({ status, refund }: { status: BetStatus; refund?: boolean | null }) {
  const s = BET[status];
  return <Badge tone={s.tone}>{status === "CLAIMED" && refund ? "Refunded" : s.label}</Badge>;
}
