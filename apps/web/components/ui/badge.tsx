import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none tracking-wide", {
  variants: {
    tone: {
      neutral: "border-line bg-surface-2 text-muted",
      accent: "border-accent/30 bg-accent-dim text-accent-bright",
      warn: "border-warn/30 bg-warn-dim text-warn",
      danger: "border-danger/30 bg-danger-dim text-danger",
      info: "border-info/30 bg-info-dim text-info",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
