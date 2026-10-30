"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function Button({ variant = "primary", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "quiet" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed",
        variant === "primary" && "bg-accent text-accent-ink hover:opacity-90",
        variant === "ghost" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "quiet" && "text-muted hover:text-ink underline-offset-4 hover:underline px-1 py-0.5",
        className,
      )}
    />
  );
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "evidence" | "hyp" | "warn" | "accent"; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "bg-surface-2 text-muted",
        tone === "evidence" && "bg-evidence-bg text-evidence",
        tone === "hyp" && "bg-hyp-bg text-hyp",
        tone === "warn" && "bg-warn-bg text-warn",
        tone === "accent" && "bg-accent text-accent-ink",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-2xl border border-line bg-surface p-5", className)}>{children}</div>;
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</div>;
}

export const CONFIDENCE_TONE = { high: "evidence", medium: "neutral", low: "warn" } as const;
