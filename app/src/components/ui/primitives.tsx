"use client";

import { Loader2 } from "lucide-react";

// Small presentational building blocks shared by every page.

export function Card({
  title,
  actions,
  children,
  className = "",
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-card shadow-sm ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/** Button styling, also for links that should look like buttons (never nest <button> in <a>). */
export function buttonClass(variant: Variant = "secondary", size: Size = "md") {
  const v = {
    primary: "bg-accent text-white hover:bg-accent/90 shadow-sm",
    secondary: "border border-border bg-card hover:bg-muted",
    ghost: "hover:bg-muted text-subtle hover:text-foreground",
    danger: "bg-red-600 text-white hover:bg-red-600/90",
  }[variant];
  const s = { sm: "h-8 px-2.5 text-xs gap-1.5", md: "h-9 px-3.5 text-sm gap-2", lg: "h-11 px-5 text-sm gap-2" }[size];
  return `inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 ${v} ${s}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  icon,
  children,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      className={`${buttonClass(variant, size)} ${className}`}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: "neutral" | "green" | "blue" | "amber" | "red" | "violet";
  children: React.ReactNode;
  className?: string;
}) {
  const t = {
    neutral: "bg-muted text-subtle",
    green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    blue: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
    amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    red: "bg-red-500/15 text-red-700 dark:text-red-300",
    violet: "bg-accent/15 text-accent",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${t} ${className}`}>
      {children}
    </span>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value ? "bg-card text-foreground shadow-sm" : "text-subtle hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
}: {
  label: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-xs text-subtle">
        {label}
        <span className="font-mono text-foreground">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </label>
  );
}

export function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-background/50 p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-subtle">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-lg leading-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-subtle">{sub}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted ${className}`} />;
}

export function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <div className="mb-3 text-subtle">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-1 max-w-sm text-xs text-subtle">{children}</p>}
    </div>
  );
}
