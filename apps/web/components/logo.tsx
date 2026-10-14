export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" fill="#0b3b2c" />
        <path d="M9.5 21.5 16 9l6.5 12.5" fill="none" stroke="#34d399" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12.3 17.2h7.4" stroke="#34d399" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">
        Fair<span className="text-accent-bright">Play</span>
      </span>
    </span>
  );
}
