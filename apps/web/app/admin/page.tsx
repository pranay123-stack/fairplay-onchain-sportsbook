"use client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Gavel, KeyRound, Loader2, LogOut, Pencil, Plus, Shuffle, ShieldCheck, Square, Play, Ban, CheckCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAccount, useSignMessage } from "wagmi";
import { formatOdds, formatUsdc, MARKET_TYPE_LABEL, MARKET_TYPES, type EventDTO, type MarketDTO, type MarketType } from "@fairplay/shared";
import { Notice } from "@/components/bet-slip";
import { MarketStatusBadge } from "@/components/status";
import { TxLink } from "@/components/tx-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, ApiError, useChainEvents, useEvents, useStats } from "@/lib/api";
import { useAdminSession } from "@/lib/store";
import { formatDateTime, relativeTime, shortAddr } from "@/lib/utils";

function useAdminApi() {
  const { token, clearSession } = useAdminSession();
  return async <T,>(path: string, init: RequestInit = {}) => {
    try {
      return await api<T>(path, { ...init, token });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.code === "ROLE_REVOKED")) clearSession();
      throw e;
    }
  };
}

export default function AdminPage() {
  const { address, isConnected } = useAccount();
  const session = useAdminSession();
  const sessionValid = session.token && session.address === address?.toLowerCase() && session.expiresAt && new Date(session.expiresAt) > new Date();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin console</h1>
          <p className="mt-1 text-sm text-muted">Sign-in is a wallet signature; every request re-checks your on-chain role. Contract roles still gate every transaction.</p>
        </div>
        {sessionValid ? (
          <div className="flex items-center gap-2">
            <Badge tone="accent">
              <ShieldCheck className="size-3" /> {shortAddr(session.address)} · {session.roles.filter((r) => r !== "DEFAULT_ADMIN_ROLE").length + 1} roles
            </Badge>
            <SignOut />
          </div>
        ) : null}
      </div>
      {!isConnected ? <ConnectPrompt /> : !sessionValid ? <SignIn /> : <Dashboard />}
    </div>
  );
}

function ConnectPrompt() {
  const { openConnectModal } = useConnectModal();
  return (
    <Card className="mx-auto max-w-md p-8 text-center">
      <KeyRound className="mx-auto mb-3 size-6 text-muted" />
      <p className="font-semibold">Connect the admin wallet</p>
      <p className="mt-1 text-sm text-muted">Locally, choose “Anvil dev · Admin (dev)”. The address must hold MARKET_MANAGER_ROLE or DEFAULT_ADMIN_ROLE on BettingMarket.</p>
      <Button className="mt-5" onClick={openConnectModal}>Connect wallet</Button>
    </Card>
  );
}

function SignIn() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const setSession = useAdminSession((s) => s.setSession);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const { message } = await api<{ message: string }>(`/api/auth/nonce?address=${address}`);
      const signature = await signMessageAsync({ message });
      const s = await api<{ token: string; address: string; expiresAt: string; roles: string[] }>("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, message, signature }),
      });
      setSession(s);
      toast.success("Signed in", { description: `Roles: ${s.roles.join(", ")}` });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mx-auto max-w-md p-8 text-center">
      <KeyRound className="mx-auto mb-3 size-6 text-muted" />
      <p className="font-semibold">Sign in with your wallet</p>
      <p className="mt-1 text-sm text-muted">You will sign a one-time, expiring challenge. It cannot move funds and cannot be replayed.</p>
      {error ? (
        <div className="mt-4 text-left">
          <Notice tone="danger" testId="admin-signin-error">{error}</Notice>
        </div>
      ) : null}
      <Button className="mt-5" onClick={signIn} disabled={busy} data-testid="admin-sign-in">
        {busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Sign in
      </Button>
    </Card>
  );
}

function SignOut() {
  const { clearSession } = useAdminSession();
  const call = useAdminApi();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await call("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
        clearSession();
      }}
    >
      <LogOut /> Sign out
    </Button>
  );
}

function Dashboard() {
  return (
    <Tabs defaultValue="markets" className="space-y-5">
      <TabsList>
        <TabsTrigger value="markets">Markets</TabsTrigger>
        <TabsTrigger value="create">Create</TabsTrigger>
        <TabsTrigger value="activity">Transactions & audit</TabsTrigger>
      </TabsList>
      <Metrics />
      <TabsContent value="markets">
        <MarketsTable />
      </TabsContent>
      <TabsContent value="create">
        <div className="grid gap-5 lg:grid-cols-2">
          <CreateEvent />
          <CreateMarket />
        </div>
      </TabsContent>
      <TabsContent value="activity">
        <Activity_ />
      </TabsContent>
    </Tabs>
  );
}

function Metrics() {
  const { data: s } = useStats();
  const call = useAdminApi();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => call<{ enabled: boolean }>("/api/admin/odds-engine", { method: "POST", body: JSON.stringify({ enabled }) }),
    onSuccess: (r) => {
      toast.success(`Simulated odds engine ${r.enabled ? "on" : "off"}`);
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });
  const tiles = [
    ["Free liquidity", s ? formatUsdc(s.onchain.freeLiquidity, 0) : "…"],
    ["Reserved liability", s ? formatUsdc(s.onchain.totalReserved, 0) : "…"],
    ["Open stake", s ? formatUsdc(s.onchain.openStake, 0) : "…"],
    ["Owed to bettors", s ? formatUsdc(s.onchain.outstandingClaims) : "…"],
    ["Accrued fees", s ? formatUsdc(s.onchain.accruedFees) : "…"],
    ["Bets / markets", s ? `${s.onchain.betCount} / ${s.onchain.marketCount}` : "…"],
  ];
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line sm:grid-cols-3 xl:grid-cols-6">
        {tiles.map(([k, v]) => (
          <div key={k} className="bg-surface p-3">
            <p className="text-[10px] uppercase tracking-wider text-faint">{k}</p>
            <p className="mt-1 font-mono text-sm font-semibold tabular">{v}</p>
          </div>
        ))}
      </div>
      <Card className="flex items-center justify-between gap-3 p-3">
        <div>
          <p className="text-xs font-medium">Simulated odds engine</p>
          <p className="text-[11px] text-muted">every {s?.oddsEngine.intervalSeconds.join("–")}s · simulated, not a feed</p>
        </div>
        <Button
          size="sm"
          variant={s?.oddsEngine.enabled ? "secondary" : "outline"}
          disabled={!s || toggle.isPending}
          onClick={() => toggle.mutate(!s!.oddsEngine.enabled)}
          data-testid="odds-engine-toggle"
        >
          {s?.oddsEngine.enabled ? "On" : "Off"}
        </Button>
      </Card>
    </div>
  );
}

function MarketsTable() {
  const { data: events } = useEvents({ status: "all" });
  const rows = (events ?? []).flatMap((e) => e.markets.map((m) => ({ e, m }))).sort((a, b) => (a.m.onchainId ?? 0) - (b.m.onchainId ?? 0));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Markets</CardTitle>
          <CardDescription>Close/reopen/odds are sent by the operator service key; results go through the mock-oracle reporter key.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-xs">
          <thead className="text-faint">
            <tr className="text-left">
              <th className="pb-2 font-medium">#</th>
              <th className="pb-2 font-medium">Event / market</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Odds</th>
              <th className="pb-2 text-right font-medium">Staked</th>
              <th className="pb-2 text-right font-medium">Reserved</th>
              <th className="pb-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ e, m }) => (
              <MarketRow key={m.id} event={e} market={m} />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function MarketRow({ event, market }: { event: EventDTO; market: MarketDTO }) {
  const call = useAdminApi();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | "odds" | "resolve" | "cancel">(null);
  const run = useMutation({
    mutationFn: ({ path, body, method = "POST" }: { path: string; body?: unknown; method?: string }) =>
      call<{ txHash?: string | null }>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    onSuccess: (r, v) => {
      toast.success("Confirmed on-chain", { description: r?.txHash ? `${v.path.split("/").pop()} · ${r.txHash.slice(0, 18)}…` : undefined });
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error("Action failed", { description: e instanceof Error ? e.message : String(e) }),
  });
  const kickoffPassed = new Date(market.closeTime).getTime() <= Date.now();
  const live = market.status === "OPEN" || market.status === "PENDING" || market.status === "CLOSED";
  const resultFinal = market.oracleResult && new Date(market.oracleResult.finalAt).getTime() <= Date.now();

  return (
    <tr className="border-t border-line align-middle" data-testid={`admin-market-${market.onchainId}`}>
      <td className="py-2.5 font-mono text-faint">{market.onchainId ?? "—"}</td>
      <td className="py-2.5">
        <p className="font-medium text-fg">
          {event.homeTeam} vs {event.awayTeam}
        </p>
        <p className="text-faint">
          {market.title} · <span suppressHydrationWarning>{formatDateTime(market.closeTime)}</span>
        </p>
      </td>
      <td className="py-2.5">
        <MarketStatusBadge status={market.status} />
        {market.oracleResult ? (
          <p className="mt-1 text-[10px] text-info">
            result: {market.oracleResult.status === "CANCELLED" ? "cancelled" : market.outcomes[market.oracleResult.winningOutcome ?? 0]?.label} {resultFinal ? "(final)" : "(dispute window)"}
          </p>
        ) : null}
      </td>
      <td className="py-2.5 font-mono">{market.outcomes.map((o) => formatOdds(o.odds)).join(" / ")}</td>
      <td className="py-2.5 text-right font-mono tabular">{formatUsdc(market.totalStake, 0)}</td>
      <td className="py-2.5 text-right font-mono tabular">{formatUsdc(market.reserved, 0)}</td>
      <td className="py-2.5">
        <div className="flex flex-wrap justify-end gap-1">
          {run.isPending ? <Loader2 className="size-4 animate-spin text-muted" /> : null}
          {market.status === "OPEN" ? (
            <Button size="sm" variant="secondary" onClick={() => run.mutate({ path: `/api/admin/markets/${market.id}/close` })} disabled={run.isPending} data-testid="close-market">
              <Square /> Close
            </Button>
          ) : null}
          {(market.status === "PENDING" || (market.status === "CLOSED" && !market.oracleResult)) && !kickoffPassed ? (
            <Button size="sm" variant="secondary" onClick={() => run.mutate({ path: `/api/admin/markets/${market.id}`, method: "PATCH", body: { status: "OPEN" } })} disabled={run.isPending}>
              <Play /> {market.status === "CLOSED" ? "Reopen" : "Open"}
            </Button>
          ) : null}
          {market.status === "OPEN" ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setDialog("odds")} title="Edit odds">
                <Pencil />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => run.mutate({ path: `/api/admin/markets/${market.id}/simulate-odds` })} title="Simulate an odds move" disabled={run.isPending}>
                <Shuffle />
              </Button>
            </>
          ) : null}
          {live && !market.oracleResult && (market.status === "CLOSED" || kickoffPassed) ? (
            <Button size="sm" onClick={() => setDialog("resolve")} data-testid="resolve-market">
              <Gavel /> Resolve
            </Button>
          ) : null}
          {live && resultFinal ? (
            <Button size="sm" onClick={() => run.mutate({ path: `/api/admin/markets/${market.id}/settle` })} disabled={run.isPending} data-testid="settle-market">
              <CheckCheck /> Settle
            </Button>
          ) : null}
          {live && !(market.oracleResult?.status === "RESOLVED" && resultFinal) ? (
            <Button size="sm" variant="danger" onClick={() => setDialog("cancel")} title="Cancel market & refund">
              <Ban />
            </Button>
          ) : null}
        </div>
        <EditOddsDialog market={market} open={dialog === "odds"} onClose={() => setDialog(null)} />
        <ResolveDialog market={market} open={dialog === "resolve"} onClose={() => setDialog(null)} />
        <CancelDialog market={market} open={dialog === "cancel"} onClose={() => setDialog(null)} />
      </td>
    </tr>
  );
}

/** Fetches a single-use challenge bound to the exact parameters and has the wallet sign it. */
function useSignedAction() {
  const call = useAdminApi();
  const { signMessageAsync } = useSignMessage();
  return async (action: "resolve" | "cancel", marketId: string, params: Record<string, string | number>) => {
    const { nonce, message } = await call<{ nonce: string; message: string }>("/api/auth/action-nonce", {
      method: "POST",
      body: JSON.stringify({ action, marketId, params }),
    });
    const signature = await signMessageAsync({ message });
    return { nonce, signature };
  };
}

function EditOddsDialog({ market, open, onClose }: { market: MarketDTO; open: boolean; onClose: () => void }) {
  const call = useAdminApi();
  const qc = useQueryClient();
  const [odds, setOdds] = useState<string[]>(market.outcomes.map((o) => formatOdds(o.odds)));
  const save = useMutation({
    mutationFn: () => call<{ txHash: string }>(`/api/admin/markets/${market.id}`, { method: "PATCH", body: JSON.stringify({ odds }) }),
    onSuccess: () => {
      toast.success("Odds sent on-chain", { description: "Shown as pending until the indexer confirms the OddsUpdated event." });
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.error("Odds update failed", { description: (e as Error).message }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit odds · ${market.title}`} description="Applies to NEW bets only. Accepted bets keep their locked odds.">
        <div className="space-y-3">
          {market.outcomes.map((o, i) => (
            <div key={o.index} className="grid grid-cols-[1fr_120px] items-center gap-3">
              <Label className="mb-0">{o.label}</Label>
              <Input value={odds[i]} onChange={(e) => setOdds((p) => p.map((v, j) => (j === i ? e.target.value : v)))} className="font-mono" />
            </div>
          ))}
          <Button className="w-full" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null} Send setOdds transaction
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({ market, open, onClose }: { market: MarketDTO; open: boolean; onClose: () => void }) {
  const call = useAdminApi();
  const sign = useSignedAction();
  const qc = useQueryClient();
  const [winner, setWinner] = useState(0);
  const [source, setSource] = useState("FairPlay mock oracle — admin-attested demo result");
  const resolve = useMutation({
    mutationFn: async () => {
      const sig = await sign("resolve", market.id, { winningOutcome: winner, source });
      return call<{ txHash: string }>(`/api/admin/markets/${market.id}/resolve`, { method: "POST", body: JSON.stringify({ winningOutcome: winner, source, ...sig }) });
    },
    onSuccess: (r) => {
      toast.success("Result published to the mock oracle", { description: `Settlement becomes available after the dispute window · ${r.txHash.slice(0, 18)}…` });
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.error("Resolve failed", { description: (e as Error).message }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Resolve · ${market.title}`} description="Publishes a result through the MockOracleAdapter (reporter service key).">
        <div className="space-y-4">
          <Notice tone="warn">
            This is an admin-attested result for a simulated fixture. The contract checks who reported it and when — not whether it is true. You will be asked to
            sign this exact action (single use).
          </Notice>
          <div className="grid gap-2">
            {market.outcomes.map((o) => (
              <label key={o.index} className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2.5 text-sm ${winner === o.index ? "border-accent bg-accent-dim" : "border-line"}`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="winner" checked={winner === o.index} onChange={() => setWinner(o.index)} className="accent-emerald-500" data-testid={`winner-${o.index}`} />
                  {o.label}
                </span>
                <span className="font-mono text-xs text-muted">{formatUsdc(o.stake, 0)} staked</span>
              </label>
            ))}
          </div>
          <div>
            <Label>Result source (recorded on-chain)</Label>
            <Input value={source} onChange={(e) => setSource(e.target.value)} />
          </div>
          <Button className="w-full" onClick={() => resolve.mutate()} disabled={resolve.isPending} data-testid="confirm-resolve">
            {resolve.isPending ? <Loader2 className="animate-spin" /> : <Gavel />} Sign & publish result
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ market, open, onClose }: { market: MarketDTO; open: boolean; onClose: () => void }) {
  const call = useAdminApi();
  const sign = useSignedAction();
  const qc = useQueryClient();
  const [reason, setReason] = useState("Fixture postponed (simulated)");
  const [via, setVia] = useState<"manager" | "oracle">("manager");
  const cancel = useMutation({
    mutationFn: async () => {
      const sig = await sign("cancel", market.id, { reason, via });
      return call<{ txHash: string }>(`/api/admin/markets/${market.id}/cancel`, { method: "POST", body: JSON.stringify({ reason, via, ...sig }) });
    },
    onSuccess: () => {
      toast.success(via === "manager" ? "Market cancelled — stakes refundable" : "Cancellation reported to the oracle — refunds after the dispute window");
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.error("Cancel failed", { description: (e as Error).message }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Cancel · ${market.title}`} description="Every stake becomes refundable. Not possible once a valid result is final.">
        <div className="space-y-4">
          <div>
            <Label>Reason (recorded on-chain)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <Label>Route</Label>
            <Select value={via} onChange={(e) => setVia(e.target.value as "manager" | "oracle")}>
              <option value="manager">Market manager cancels directly (immediate)</option>
              <option value="oracle">Oracle reports fixture cancelled (after dispute window)</option>
            </Select>
          </div>
          <Button variant="danger" className="w-full" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? <Loader2 className="animate-spin" /> : <Ban />} Sign & cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateEvent() {
  const call = useAdminApi();
  const qc = useQueryClient();
  const defaultStart = new Date(Date.now() + 26 * 3600_000);
  defaultStart.setMinutes(0, 0, 0);
  const [f, setF] = useState({ sport: "football", league: "Demo League", homeTeam: "", awayTeam: "", start: toLocalInput(defaultStart), venue: "", featured: false });
  const create = useMutation({
    mutationFn: () =>
      call<{ id: string; txHash: string }>("/api/admin/events", {
        method: "POST",
        body: JSON.stringify({ sport: f.sport, league: f.league, homeTeam: f.homeTeam, awayTeam: f.awayTeam, startTime: new Date(f.start).toISOString(), venue: f.venue || undefined, featured: f.featured }),
      }),
    onSuccess: (r) => {
      toast.success("Event created on-chain", { description: r.txHash.slice(0, 22) + "…" });
      void qc.invalidateQueries();
      setF((p) => ({ ...p, homeTeam: "", awayTeam: "" }));
    },
    onError: (e) => toast.error("Create event failed", { description: (e as Error).message }),
  });
  return (
    <Card data-testid="create-event-card">
      <CardHeader>
        <CardTitle>Create event</CardTitle>
        <Badge>createEvent()</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Sport</Label>
            <Select value={f.sport} onChange={(e) => setF({ ...f, sport: e.target.value })}>
              <option value="football">Football</option>
              <option value="basketball">Basketball</option>
              <option value="esports">Esports</option>
            </Select>
          </div>
          <div>
            <Label>League</Label>
            <Input value={f.league} onChange={(e) => setF({ ...f, league: e.target.value })} />
          </div>
          <div>
            <Label>Home</Label>
            <Input value={f.homeTeam} onChange={(e) => setF({ ...f, homeTeam: e.target.value })} placeholder="Team A" />
          </div>
          <div>
            <Label>Away</Label>
            <Input value={f.awayTeam} onChange={(e) => setF({ ...f, awayTeam: e.target.value })} placeholder="Team B" />
          </div>
          <div>
            <Label>Kick-off (betting closes)</Label>
            <Input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </div>
          <div>
            <Label>Venue</Label>
            <Input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} placeholder="optional" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={f.featured} onChange={(e) => setF({ ...f, featured: e.target.checked })} /> Featured
        </label>
        <p className="text-[11px] text-faint">Created events are labelled as demonstration data.</p>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !f.homeTeam || !f.awayTeam}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Create on-chain
        </Button>
      </CardContent>
    </Card>
  );
}

function CreateMarket() {
  const call = useAdminApi();
  const qc = useQueryClient();
  const { data: events } = useEvents({ status: "upcoming" });
  const [eventId, setEventId] = useState("");
  const [type, setType] = useState<MarketType>("MONEYLINE");
  const [title, setTitle] = useState("Match winner");
  const [rules, setRules] = useState("Settles on the official final result. If the fixture is not completed within 48 hours, all stakes are refunded. Result source: FairPlay mock oracle (admin-attested).");
  const [outcomes, setOutcomes] = useState([{ label: "Home", odds: "1.90" }, { label: "Away", odds: "1.90" }]);
  const [limits, setLimits] = useState({ minStake: "1", maxStake: "5000", maxLiability: "50000" });
  const [simulate, setSimulate] = useState(true);
  const create = useMutation({
    mutationFn: () =>
      call<{ marketId: string; onchainId: number; txHash: string }>("/api/admin/markets", {
        method: "POST",
        body: JSON.stringify({ eventId, type, title, rules, outcomes, ...limits, openImmediately: true, simulateOdds: simulate }),
      }),
    onSuccess: (r) => {
      toast.success(`Market #${r.onchainId} created and opened`);
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error("Create market failed", { description: (e as Error).message }),
  });
  return (
    <Card data-testid="create-market-card">
      <CardHeader>
        <CardTitle>Create market</CardTitle>
        <Badge>createMarket() + openMarket()</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Event</Label>
          <Select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Select an upcoming event…</option>
            {(events ?? []).map((e) => (
              <option key={e.id} value={e.id} disabled={e.onchainId === null}>
                {e.homeTeam} vs {e.awayTeam} · {formatDateTime(e.startTime)}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Type</Label>
            <Select value={type} onChange={(e) => setType(e.target.value as MarketType)}>
              {MARKET_TYPES.map((t) => (
                <option key={t} value={t}>{MARKET_TYPE_LABEL[t]}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Outcomes & initial decimal odds</Label>
          <div className="space-y-2">
            {outcomes.map((o, i) => (
              <div key={i} className="grid grid-cols-[1fr_100px_32px] gap-2">
                <Input value={o.label} onChange={(e) => setOutcomes((p) => p.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <Input value={o.odds} onChange={(e) => setOutcomes((p) => p.map((x, j) => (j === i ? { ...x, odds: e.target.value } : x)))} className="font-mono" />
                <Button variant="ghost" size="icon" onClick={() => setOutcomes((p) => p.filter((_, j) => j !== i))} disabled={outcomes.length <= 2} aria-label="Remove outcome">
                  ×
                </Button>
              </div>
            ))}
            {outcomes.length < 8 ? (
              <Button variant="outline" size="sm" onClick={() => setOutcomes((p) => [...p, { label: "Draw", odds: "3.40" }])}>
                <Plus /> Add outcome
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {(["minStake", "maxStake", "maxLiability"] as const).map((k) => (
            <div key={k}>
              <Label>{k === "maxLiability" ? "Max liability" : k === "minStake" ? "Min stake" : "Max stake"}</Label>
              <Input value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} className="font-mono" />
            </div>
          ))}
        </div>
        <div>
          <Label>Rules</Label>
          <Textarea value={rules} onChange={(e) => setRules(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={simulate} onChange={(e) => setSimulate(e.target.checked)} /> Include in simulated odds engine
        </label>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !eventId}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Create & open on-chain
        </Button>
      </CardContent>
    </Card>
  );
}

interface AuditRow {
  id: string;
  address: string;
  action: string;
  target: string | null;
  txHash: string | null;
  outcome: string;
  error: string | null;
  createdAt: string;
}
interface BackendTx {
  hash: string;
  kind: string;
  service: string;
  status: string;
  blockNumber: number | null;
  createdAt: string;
}

function Activity_() {
  const call = useAdminApi();
  const audit = useQuery({ queryKey: ["admin-audit"], queryFn: () => call<AuditRow[]>("/api/admin/audit-log"), refetchInterval: 5000 });
  const txs = useQuery({ queryKey: ["admin-txs"], queryFn: () => call<BackendTx[]>("/api/admin/transactions"), refetchInterval: 5000 });
  const { data: logs } = useChainEvents();
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card className="xl:col-span-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-muted" /> Backend transactions
          </CardTitle>
        </CardHeader>
        <CardContent className="max-h-[480px] space-y-1 overflow-y-auto text-xs">
          {(txs.data ?? []).map((t) => (
            <div key={t.hash} className="flex items-center justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
              <span className="min-w-0 truncate">
                <span className="font-mono text-fg">{t.kind}</span> <span className="text-faint">· {t.service}</span>
              </span>
              <Badge tone={t.status === "CONFIRMED" ? "accent" : t.status === "SUBMITTED" ? "warn" : "danger"}>{t.status.toLowerCase()}</Badge>
              <TxLink hash={t.hash} />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Admin audit log</CardTitle>
        </CardHeader>
        <CardContent className="max-h-[480px] space-y-1 overflow-y-auto text-xs">
          {(audit.data ?? []).map((a) => (
            <div key={a.id} className="border-t border-line py-1.5 first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-fg">{a.action}</span>
                <Badge tone={a.outcome === "OK" ? "accent" : "danger"}>{a.outcome}</Badge>
              </div>
              <p className="text-faint" suppressHydrationWarning>
                {shortAddr(a.address)} · {relativeTime(a.createdAt)} {a.txHash ? <TxLink hash={a.txHash} /> : null}
              </p>
              {a.error ? <p className="text-danger">{a.error}</p> : null}
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Contract events</CardTitle>
        </CardHeader>
        <CardContent className="max-h-[480px] space-y-1 overflow-y-auto text-xs">
          {(logs ?? []).map((l) => (
            <div key={`${l.txHash}-${l.logIndex}`} className="flex items-center justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
              <span className="font-mono text-accent-bright">{l.eventName}</span>
              <span className="font-mono text-faint">#{l.blockNumber}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
