"use client";

import { createContext, useContext, useEffect, useState } from "react";

import type { EndpointView } from "@/lib/types";

import { getJson } from "./api";

interface EndpointState {
  ep: EndpointView | null;
  error: string | null;
  refresh: () => void;
}

const Ctx = createContext<EndpointState>({ ep: null, error: null, refresh: () => {} });

const POLL_MS = 5000;

/** Polls one endpoint's /api/endpoint view, keeping the last good data on failures. */
export function usePolledEndpoint(which: "image" | "video", intervalMs: number): EndpointState {
  const [ep, setEp] = useState<EndpointView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await getJson<EndpointView>(which === "video" ? "/api/endpoint?which=video" : "/api/endpoint");
      if (cancelled) return;
      if (res.ok) {
        setEp(res.data);
        setError(null);
      } else {
        // Keep the last good data; the UI marks it as stale.
        setError(res.error ?? "Unknown error");
      }
    };
    const first = setTimeout(load, 0);
    const t = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [tick, which, intervalMs]);

  return { ep, error, refresh: () => setTick((n) => n + 1) };
}

/** Polls the image endpoint once for the whole app (sidebar status + Studio endpoint card). */
export function EndpointProvider({ children }: { children: React.ReactNode }) {
  const state = usePolledEndpoint("image", POLL_MS);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useEndpoint = () => useContext(Ctx);

/** Overall state for the status pill. */
export function endpointStatus(ep: EndpointView | null, error: string | null) {
  if (!ep) return error ? { tone: "red", label: "Unreachable" } : { tone: "neutral", label: "Connecting…" };
  const w = ep.health?.workers ?? {};
  // "running" includes a worker staying warm through its idle timeout; Runpod's
  // "idle" workers are stopped (not billed) but cached for a fast resume.
  if ((w.running ?? 0) > 0) return { tone: "green", label: `${w.running} active` };
  if ((w.initializing ?? 0) > 0) return { tone: "amber", label: "Starting a worker" };
  if ((w.unhealthy ?? 0) > 0) return { tone: "red", label: "Worker unhealthy" };
  if ((w.idle ?? 0) > 0) return { tone: "blue", label: "Scaled to zero · ready" };
  return { tone: "blue", label: "Scaled to zero" };
}
