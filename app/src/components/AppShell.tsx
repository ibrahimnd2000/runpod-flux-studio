"use client";

import { BookOpen, Images, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { endpointStatus, useEndpoint } from "./EndpointProvider";
import { Tooltip } from "./ui/Tooltip";

const NAV = [
  { href: "/", label: "Studio", icon: Sparkles },
  { href: "/library", label: "Library", icon: Images },
  { href: "/about", label: "How it works", icon: BookOpen },
];

const DOT = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500", blue: "bg-sky-500", neutral: "bg-zinc-400" };

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="h-7 w-7" />
      <span>
        FLUX Studio <span className="font-normal text-subtle">on Runpod</span>
      </span>
    </Link>
  );
}

function StatusPill() {
  const { ep, error } = useEndpoint();
  const s = endpointStatus(ep, error);
  const w = ep?.health?.workers;
  return (
    <Tooltip
      side="top"
      className="w-full"
      content={
        <>
          <b>GPU endpoint {ep?.id ?? ""}</b>
          <br />
          {w
            ? `${w.running ?? 0} active · ${w.idle ?? 0} cached · ${w.initializing ?? 0} starting · max ${ep?.workersMax ?? "–"} workers.`
            : (error ?? "Loading status…")}{" "}
          Scaled to zero means no GPU is billed; the next request resumes or starts a worker, which adds a cold start.
        </>
      }
    >
      <span
        tabIndex={0}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
      >
        <span className="relative flex h-2 w-2">
          {s.tone === "green" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${DOT[s.tone as keyof typeof DOT]}`} />
        </span>
        <span className="font-medium">{s.label}</span>
        <span className="ml-auto text-subtle">{error && ep ? "stale" : "live"}</span>
      </span>
    </Tooltip>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card px-4 py-5 lg:flex">
        <Logo />
        <nav className="mt-8 space-y-1" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                active(href) ? "bg-accent/10 font-medium text-accent" : "text-subtle hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-3">
          <StatusPill />
          <p className="px-1 text-[11px] leading-relaxed text-subtle">
            FLUX.1-dev on a Runpod Serverless GPU endpoint. Non-commercial model licence.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-card/90 px-4 py-3 backdrop-blur lg:hidden">
          <Logo />
          <nav className="ml-auto flex gap-1" aria-label="Main">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-label={label}
                aria-current={active(href) ? "page" : undefined}
                className={`rounded-lg p-2 ${active(href) ? "bg-accent/10 text-accent" : "text-subtle"}`}
              >
                <Icon className="h-4 w-4" />
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
