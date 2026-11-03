"use client";

import { useCallback, useEffect, useState } from "react";

import type { EndpointView, HistoryView } from "@/lib/types";

import { getJson } from "./api";
import EndpointPanel from "./EndpointPanel";
import GeneratePanel from "./GeneratePanel";
import HistoryPanel from "./HistoryPanel";

export default function Dashboard() {
  const [ep, setEp] = useState<EndpointView | null>(null);
  const [epError, setEpError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryView | null>(null);

  const loadEndpoint = useCallback(async () => {
    try {
      const { ok, status, data } = await getJson<EndpointView & { error?: string }>("/api/endpoint");
      if (!ok) throw new Error(data.error ?? `HTTP ${status}`);
      setEp(data);
      setEpError(null);
    } catch (e) {
      setEpError((e as Error).message);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    // Keep the last good history on transient failures; the next refresh retries.
    const { ok, data } = await getJson<HistoryView>("/api/history").catch(() => ({ ok: false, data: null }));
    if (ok && data) setHistory(data);
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
