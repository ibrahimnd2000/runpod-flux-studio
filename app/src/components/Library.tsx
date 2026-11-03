"use client";

import { useCallback, useEffect, useState } from "react";

import type { MediaItem, MediaView } from "@/lib/types";

import { getJson } from "./api";
import { ago, secs, shortGpu, usd } from "./format";
import Notice from "./Notice";
import { useAccessCode } from "./useAccessCode";

const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

export default function Library() {
  const [view, setView] = useState<MediaView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<{ tone: "warn" | "error"; title: string; detail?: string } | null>(null);
  const { code, setCode, remember } = useAccessCode();

  const load = useCallback(async () => {
    const res = await getJson<MediaView>("/api/media");
    if (res.ok) {
      setView(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error ?? "Unknown error");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 20000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const items = (view?.items ?? []).filter((i) => i.prompt.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function deleteSelected() {
    if (!code) {
      setProblem({ tone: "error", title: "Enter the access code to delete images" });
      return;
    }
    remember(code);
    setDeleting(true);
    setProblem(null);
    const ids = [...selected];
    const results = await Promise.all(
      ids.map((id) => getJson<{ deleted: string }>(`/api/media/${id}`, { method: "DELETE", headers: { "x-access-code": code } })),
    );
    const failed = results.filter((r) => !r.ok && r.status !== 404);
    if (failed.length) {
      setProblem({
        tone: "error",
        title: failed[0].status === 401 ? "Access code not accepted" : `${failed.length} of ${ids.length} images couldn't be deleted`,
        detail: failed[0].error,
      });
    }
    setSelected(new Set(ids.filter((_, i) => !results[i].ok && results[i].status !== 404)));
    if (open && ids.includes(open.id) && !failed.length) setOpen(null);
    setConfirming(false);
    setDeleting(false);
    load();
  }

  return (
    <div className="space-y-5">
      <section className="card">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="input max-w-xs"
            placeholder="Search prompts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search prompts"
          />
          <span className="text-xs text-subtle">
            {view
              ? `${view.usage.count} images · ${mb(view.usage.bytes)}${view.usage.persistent ? " on the pod's network volume" : " in memory (no DATA_DIR)"}`
              : "Loading…"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && (
              <>
                <span className="text-xs text-subtle">{selected.size} selected</span>
                <button type="button" className="chip" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                <input
                  className="input w-40"
                  type="password"
                  placeholder="Access code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-label="Access code"
                  autoComplete="off"
                />
                {confirming ? (
                  <>
                    <button
                      type="button"
                      className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                      onClick={deleteSelected}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting…" : `Delete ${selected.size} permanently`}
                    </button>
                    <button type="button" className="chip" onClick={() => setConfirming(false)} disabled={deleting}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" className="chip hover:border-red-500 hover:text-red-500" onClick={() => setConfirming(true)}>
                    Delete…
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {(problem || loadError) && (
          <div className="mt-3 space-y-2">
            {problem && (
              <Notice tone={problem.tone} title={problem.title}>
                {problem.detail}
              </Notice>
            )}
            {loadError && (
              <Notice tone={view ? "warn" : "error"} title={view ? "Showing the last loaded library" : "Couldn't load the library"}>
                {loadError} Retrying every 20 s.
              </Notice>
            )}
          </div>
        )}
      </section>

      {view && items.length === 0 && (
        <p className="text-sm text-subtle">
          {view.items.length ? "No images match your search." : "No images yet. Generated images are saved here automatically."}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item) => {
          const isSelected = selected.has(item.id);
          return (
            <figure
              key={item.id}
              className={`group overflow-hidden rounded-lg border bg-card ${isSelected ? "border-accent ring-2 ring-accent" : "border-border"}`}
            >
              <div className="relative aspect-square bg-muted">
                <button type="button" className="h-full w-full" onClick={() => setOpen(item)} aria-label="Open image">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/media/${item.id}`} alt={item.prompt} loading="lazy" className="h-full w-full object-cover" />
                </button>
                <label className="absolute top-1.5 left-1.5 flex cursor-pointer items-center rounded bg-black/60 p-1">
                  <input type="checkbox" checked={isSelected} onChange={() => toggle(item.id)} aria-label="Select image" />
                </label>
              </div>
              <figcaption className="space-y-0.5 p-2 text-[11px]">
                <p className="truncate" title={item.prompt}>
                  {item.prompt}
                </p>
                <p className="flex justify-between text-subtle">
                  <span>{ago(item.createdAt)}</span>
                  <span>{shortGpu(item.gpu)}</span>
                </p>
              </figcaption>
            </figure>
          );
        })}
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="card max-h-full w-full max-w-4xl overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/media/${open.id}`} alt={open.prompt} className="w-full rounded-lg" />
              <div className="space-y-4 text-sm">
                <p>{open.prompt}</p>
                <dl className="kv">
                  <dt>Size</dt>
                  <dd>
                    {open.width}×{open.height}, {open.steps} steps
                  </dd>
                  <dt>Seed</dt>
                  <dd>{open.seed ?? "–"}</dd>
                  <dt>GPU</dt>
                  <dd>{shortGpu(open.gpu)}</dd>
                  <dt>Execution</dt>
                  <dd>{secs(open.executionMs)}</dd>
                  <dt>Cost</dt>
                  <dd>{usd(open.costUsd)}</dd>
                  <dt>Created</dt>
                  <dd>{new Date(open.createdAt).toLocaleString()}</dd>
                </dl>
                <div className="flex gap-2">
                  <a className="btn" href={`/api/media/${open.id}?download`}>
                    Download
                  </a>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setSelected(new Set([open.id]));
                      setConfirming(true);
                      setOpen(null);
                    }}
                  >
                    Delete…
                  </button>
                  <button type="button" className="chip ml-auto" onClick={() => setOpen(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
