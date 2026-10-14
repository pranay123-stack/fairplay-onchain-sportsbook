"use client";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatOdds } from "@fairplay/shared";
import type { OddsHistoryPoint } from "@/lib/api";

// Categorical slots 1–3 of the reference palette, dark steps — validated on #111418 (all checks pass).
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Confirmed (on-chain) odds over time, one step line per outcome. Pending proposals are excluded. */
export function OddsChart({ history, labels }: { history: OddsHistoryPoint[]; labels: string[] }) {
  const [table, setTable] = useState(false);
  const confirmed = history.filter((h) => h.status === "CONFIRMED");
  const rows = confirmed.map((h) => {
    const row: Record<string, number | string> = { t: new Date(h.confirmedAt ?? h.createdAt).getTime(), v: h.version ?? 0 };
    h.odds.forEach((o, i) => (row[`o${i}`] = Number(o) / 10_000));
    return row;
  });
  // Extend the last step to "now" so a flat price still reads as a line.
  if (rows.length) rows.push({ ...rows[rows.length - 1]!, t: Date.now() });

  if (confirmed.length === 0) return <p className="py-8 text-center text-xs text-muted">No confirmed odds yet.</p>;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {labels.map((l, i) => (
          <span key={l} className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="h-0.5 w-4 rounded-full" style={{ background: SERIES[i] }} />
            {l}
          </span>
        ))}
        <button onClick={() => setTable((v) => !v)} className="ml-auto text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
          {table ? "Show chart" : "Show table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Version</th>
                <th className="px-3 py-2 text-left font-medium">Confirmed</th>
                {labels.map((l) => (
                  <th key={l} className="px-3 py-2 text-right font-medium">{l}</th>
                ))}
                <th className="px-3 py-2 text-left font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {[...confirmed].reverse().map((h) => (
                <tr key={`${h.version}-${h.txHash}`} className="border-t border-line">
                  <td className="px-3 py-1.5 font-mono">v{h.version}</td>
                  <td className="px-3 py-1.5 text-muted">{new Date(h.confirmedAt ?? h.createdAt).toLocaleTimeString()}</td>
                  {h.odds.map((o, i) => (
                    <td key={i} className="px-3 py-1.5 text-right font-mono tabular">{formatOdds(o)}</td>
                  ))}
                  <td className="px-3 py-1.5 text-muted">{h.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-56" role="img" aria-label={`Odds history for ${labels.join(", ")}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid stroke="#232932" strokeDasharray="0" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                stroke="#5d6573"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis stroke="#5d6573" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={(v) => Number(v).toFixed(2)} />
              <Tooltip
                cursor={{ stroke: "#5d6573", strokeWidth: 1 }}
                contentStyle={{ background: "#161a20", border: "1px solid #2f3641", borderRadius: 10, fontSize: 12 }}
                labelStyle={{ color: "#8b94a3" }}
                itemStyle={{ color: "#f4f6f8" }}
                labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                formatter={(v, name) => [Number(v).toFixed(2), labels[Number(String(name).slice(1))] ?? name]}
              />
              {labels.map((_, i) => (
                <Line key={i} type="stepAfter" dataKey={`o${i}`} stroke={SERIES[i]} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "#111418", strokeWidth: 2 }} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="mt-2 text-[11px] text-faint">Only odds confirmed on-chain are plotted. Moves come from the simulated odds engine or an admin — there is no external feed.</p>
    </div>
  );
}
