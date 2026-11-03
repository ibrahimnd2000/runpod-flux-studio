"use client";

import { useCallback, useEffect, useState } from "react";

import type { EndpointView, HistoryView } from "@/lib/types";

import EndpointPanel from "./EndpointPanel";
import GeneratePanel from "./GeneratePanel";
import HistoryPanel from "./HistoryPanel";

export default function Dashboard() {
  const [ep, setEp] = useState<EndpointView | null>(null);
  const [epError, setEpError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryView | null>(null);

  const loadEndpoint = useCallback(async () => {
    try {
      const res = await fetch("/api/endpoint", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEp(data);
      setEpError(null);
    } catch (e) {
      setEpError((e as Error).message);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/history", { cache: "no-store" });
    if (res.ok) setHistory(await res.json());
  }, []);

  useEffect(() => {
    const first = setTimeout(() => {
      loadEndpoint();
      loadHistory();
    }, 0);
    const a = setInterval(loadEndpoint, 5000);
    const b = setInterval(loadHistory, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(a);
      clearInterval(b);
    };
  }, [loadEndpoint, loadHistory]);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <GeneratePanel
          maxSide={history?.limits.maxSide ?? 1024}
          maxSteps={history?.limits.maxSteps ?? 28}
          onFinished={() => {
            loadHistory();
            loadEndpoint();
          }}
        />
        <HistoryPanel h={history} />
      </div>
      <EndpointPanel ep={ep} error={epError} />
    </div>
  );
}
