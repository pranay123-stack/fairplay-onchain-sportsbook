"use client";
import { useEffect, useState } from "react";

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

export function Countdown({ to, className = "" }: { to: string; className?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <span className={className}>&nbsp;</span>;
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return <span className={`${className} text-warn`}>Started</span>;
  const { d, h, m, s } = parts(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className={`font-mono tabular ${className}`} suppressHydrationWarning>
      {d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(s)}`}
    </span>
  );
}
