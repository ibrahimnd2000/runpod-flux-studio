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
  const [historyError, setHistoryError] = useState<string | null>(null);

  // On failure keep showing the last good data; the panels say it's stale and the
  // next interval retries. Errors clear on the first success.
  const loadEndpoint = useCallback(async () => {
    const res = await getJson<EndpointView>("/api/endpoint");
    if (res.ok) {
      setEp(res.data);
      setEpError(null);
    } else {
      setEpError(res.error ?? "Unknown error");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await getJson<HistoryView>("/api/history");
    if (res.ok) {
      setHistory(res.data);
      setHistoryError(null);
    } else {
      setHistoryError(res.error ?? "Unknown error");
    }
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
        <HistoryPanel h={history} error={historyError} />
      </div>
      <EndpointPanel ep={ep} error={epError} />
    </div>
  );
}
