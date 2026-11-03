"use client";

import { Check, Clapperboard, Download, Images, Play, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { MediaItem, MediaView } from "@/lib/types";

import { getJson } from "./api";
import { ago, secs, shortGpu, usd } from "./format";
import Notice from "./Notice";
import { Badge, Button, buttonClass, Card, EmptyState, Skeleton } from "./ui/primitives";
import { useToast } from "./ui/Toaster";
import { Term } from "./ui/Tooltip";
import { useAccessCode } from "./useAccessCode";
import AnimateDialog, { type AnimateSource } from "./video/AnimateDialog";

const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

export default function Library() {
  const [view, setView] = useState<MediaView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<MediaItem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<{ title: string; detail?: string } | null>(null);
  const { code, setCode, remember } = useAccessCode();
  const toast = useToast();
  const [animate, setAnimate] = useState<AnimateSource | null>(null);

  const load = useCallback(async () => {
    const res = await getJson<MediaView>("/api/media");
    if (res.ok) {
      setView(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error ?? "Unknown error");
    }
  }, []);

  const closeAnimate = useCallback(() => {
    setAnimate(null);
    load(); // pick up a clip that finished meanwhile
  }, [load]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 20000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  // Esc closes the lightbox.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const q = query.trim().toLowerCase();
  const items = (view?.items ?? []).filter((i) => i.prompt.toLowerCase().includes(q));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function deleteSelected() {
    if (!code) {
      setProblem({ title: "Enter the access code to delete images" });
      return;
    }
    remember(code);
    setDeleting(true);
    setProblem(null);
    const ids = [...selected];
    const results = await Promise.all(
      ids.map((id) =>
        getJson<{ deleted: string }>(`/api/media/${id}`, { method: "DELETE", headers: { "x-access-code": code } }),
      ),
    );
    // 404 = already gone, which is what the user wanted.
    const failed = results.filter((r) => !r.ok && r.status !== 404);
    const deleted = ids.length - failed.length;
    if (failed.length) {
      setProblem({
        title: failed[0].status === 401 ? "Access code not accepted" : `${failed.length} of ${ids.length} images couldn't be deleted`,
        detail: failed[0].error,
      });
    }
    if (deleted) toast("success", `${deleted} image${deleted === 1 ? "" : "s"} deleted`);
    setSelected(new Set(ids.filter((_, i) => !results[i].ok && results[i].status !== 404)));
    setConfirming(false);
    setDeleting(false);
    load();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="mt-1 text-sm text-subtle">
            Every generated image, stored on the app&apos;s Runpod network volume.{" "}
            {view && (
              <span className="font-mono">
                {view.usage.count} images · {mb(view.usage.bytes)}
                {view.usage.persistent ? "" : " · in memory only"}
              </span>
            )}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input className="input pl-9" placeholder="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search prompts" />
        </div>
      </div>

      {(problem || loadError) && (
        <div className="space-y-2">
          {problem && <Notice tone="error" title={problem.title}>{problem.detail}</Notice>}
          {loadError && (
            <Notice tone={view ? "warn" : "error"} title={view ? "Showing the last loaded library" : "Couldn't load the library"}>
              {loadError} Retrying every 20 s.
            </Notice>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="sticky top-16 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-card px-4 py-3 shadow-lg lg:top-4">
          <Badge tone="violet">{selected.size} selected</Badge>
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => { setSelected(new Set()); setConfirming(false); }}>
            Clear
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-subtle sm:inline">
              <Term term="accessCode" side="bottom">Access code</Term>
            </span>
            <input
              className="input h-8 w-40 py-1"
              type="password"
              placeholder="Access code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Access code"
              autoComplete="off"
            />
            {confirming ? (
              <>
                <Button size="sm" variant="danger" loading={deleting} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={deleteSelected}>
                  Delete {selected.size} permanently
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirming(true)}>
                Delete…
              </Button>
            )}
          </div>
        </div>
      )}

      {!view && !loadError && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-xl" />
          ))}
        </div>
      )}

      {view && items.length === 0 && (
        <Card>
          <EmptyState icon={<Images className="h-8 w-8" />} title={view.items.length ? "No images match your search" : "No images yet"}>
            {view.items.length ? (
              "Try a different word from the prompt."
            ) : (
              <>
                Images you generate in the <Link href="/" className="text-accent hover:underline">Studio</Link> are saved here automatically.
              </>
            )}
          </EmptyState>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {items.map((item) => {
          const isSelected = selected.has(item.id);
          return (
            <figure
              key={item.id}
              className={`group overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md ${isSelected ? "border-accent ring-2 ring-accent/60" : "border-border"}`}
            >
              <div className="relative bg-muted" style={{ aspectRatio: item.width / item.height }}>
                <button type="button" className="h-full w-full" onClick={() => setOpen(item)} aria-label={`Open: ${item.prompt}`}>
                  {item.kind === "video" ? (
                    <video src={`/api/media/${item.id}#t=0.5`} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/media/${item.id}`} alt={item.prompt} loading="lazy" className="h-full w-full object-cover" />
                  )}
                </button>
                {item.kind === "video" && (
                  <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white">
                    <Play className="h-3 w-3 fill-current" /> {item.durationS ? `${item.durationS.toFixed(1)}s` : "video"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggle(item.id)}
                  aria-pressed={isSelected}
                  aria-label={isSelected ? "Deselect image" : "Select image"}
                  className={`absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-md border transition-opacity ${
                    isSelected
                      ? "border-accent bg-accent text-white opacity-100"
                      : "border-white/70 bg-black/40 text-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  }`}
                >
                  <Check className="h-4 w-4" />
                </button>
              </div>
              <figcaption className="space-y-1 p-3 text-xs">
                <p className="line-clamp-2 leading-snug" title={item.prompt}>
                  {item.prompt}
                </p>
                <p className="flex justify-between text-[11px] text-subtle">
                  <span>{ago(item.createdAt)}</span>
                  <span>
                    {item.width}×{item.height}
                  </span>
                </p>
              </figcaption>
            </figure>
          );
        })}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setOpen(null)} role="dialog" aria-modal="true" aria-label="Image details">
          <div className="max-h-full w-full max-w-5xl overflow-auto rounded-2xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {open.kind === "video" ? (
                <video src={`/api/media/${open.id}`} controls autoPlay loop playsInline className="w-full rounded-xl" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/media/${open.id}`} alt={open.prompt} className="w-full rounded-xl" />
              )}
              <div className="flex flex-col gap-4 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <p className="leading-relaxed">{open.prompt}</p>
                  <Button size="sm" variant="ghost" aria-label="Close" icon={<X className="h-4 w-4" />} onClick={() => setOpen(null)} />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-subtle">Size</dt>
                  <dd className="text-right font-mono">
                    {open.width}×{open.height}
                    {open.kind === "video" ? ` · ${open.durationS ?? "?"} s · LTX-2.5` : ` · ${open.steps} steps`}
                  </dd>
                  <dt className="text-subtle"><Term term="seed" side="right">Seed</Term></dt>
                  <dd className="text-right font-mono">{open.seed ?? "–"}</dd>
                  <dt className="text-subtle">GPU</dt>
                  <dd className="text-right">{shortGpu(open.gpu)}</dd>
                  <dt className="text-subtle"><Term term="execution" side="right">GPU time</Term></dt>
                  <dd className="text-right font-mono">{secs(open.executionMs)}</dd>
                  <dt className="text-subtle"><Term term="cost" side="right">Cost</Term></dt>
                  <dd className="text-right font-mono">{usd(open.costUsd)}</dd>
                  <dt className="text-subtle">Created</dt>
                  <dd className="text-right">{new Date(open.createdAt).toLocaleString()}</dd>
                </dl>
                <div className="mt-auto flex flex-wrap gap-2">
                  {view?.videoEnabled && open.kind !== "video" && (
                    <Button
                      variant="primary"
                      icon={<Clapperboard className="h-4 w-4" />}
                      onClick={() => {
                        setAnimate({ id: open.id, prompt: open.prompt, url: `/api/media/${open.id}` });
                        setOpen(null);
                      }}
                    >
                      Animate
                    </Button>
                  )}
                  <a className={buttonClass(open.kind === "video" || !view?.videoEnabled ? "primary" : "secondary", "md")} href={`/api/media/${open.id}?download`}>
                    <Download className="h-4 w-4" /> Download
                  </a>
                  <Button
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => {
                      setSelected(new Set([open.id]));
                      setConfirming(true);
                      setOpen(null);
                    }}
                  >
                    Delete…
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {animate && <AnimateDialog source={animate} onClose={closeAnimate} />}
    </div>
  );
}
