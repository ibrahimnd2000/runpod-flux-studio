"use client";

import { useState } from "react";

import BulkPanel from "./BulkPanel";
import GeneratePanel from "./GeneratePanel";

const TABS = [
  { key: "single", label: "Single" },
  { key: "bulk", label: "Bulk (parallel)" },
] as const;

export default function GenerateSection(props: {
  maxSide: number;
  maxSteps: number;
  bulkMax: number;
  onFinished: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("single");
  return (
    <section className="card">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="card-title mb-0">Generate</h2>
        <div role="tablist" className="flex rounded-md border border-border p-0.5 text-xs">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`rounded px-3 py-1 ${tab === t.key ? "bg-accent text-white" : "text-subtle hover:text-foreground"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {/* Both stay mounted so switching tabs doesn't drop a running job or bulk run. */}
      <div hidden={tab !== "single"}>
        <GeneratePanel maxSide={props.maxSide} maxSteps={props.maxSteps} onFinished={props.onFinished} />
      </div>
      <div hidden={tab !== "bulk"}>
        <BulkPanel {...props} />
      </div>
    </section>
  );
}
