"use client";

import { Check, GraduationCap, Images, Search, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { LoraView, LorasView, MediaItem, MediaView } from "@/lib/types";

import { getJson } from "../api";
import { ago, secs, shortGpu, usd } from "../format";
import Notice from "../Notice";
import { Badge, Button, buttonClass, Card, EmptyState, Segmented } from "../ui/primitives";
import { useToast } from "../ui/Toaster";
import { Term } from "../ui/Tooltip";
import { useAccessCode } from "../useAccessCode";

type Preset = keyof LorasView["presets"];
const PRESET_LABEL: Record<Preset, string> = { quick: "Quick", standard: "Standard", strong: "Strong" };
// Measured 4 Nov 2026 (one run, README): 800 steps at 512 px, rank 16, on an RTX 6000 Ada took
// 641 s of training (0.80 s/step) + 24 s of download, encoding and upload = 665 s of GPU time, $0.323.
// Queue time (a cold worker pulls a 30 GB image, ~5 min) isn't billed and isn't included.
const EST_S_PER_STEP = 0.8;
const EST_OVERHEAD_S = 25;
const EST_USD_PER_S = 0.323 / 665;

/** "Mug shots" -> "mug_shots": a starting point for the trigger word. */
const triggerFrom = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 20) || "";

/** Where a training LoRA really is: queued for a GPU, loading on one, or training. */
function trainingPhase(lora: LoraView): { badge: string; detail: string; onGpu: boolean } {
  const p = lora.progress;
  if (p) return { badge: "training", detail: `step ${p.step}/${p.total_steps}${p.loss !== undefined ? ` · loss ${p.loss.toFixed(3)}` : ""}`, onGpu: true };
  if (lora.jobStatus === "IN_PROGRESS") return { badge: "starting", detail: "on a GPU · loading FLUX and encoding the images…", onGpu: true };
  return { badge: "waiting for GPU", detail: "waiting for a training GPU (the first start pulls a 30 GB image, ~10 min)…", onGpu: false };
}

function StatusBadge({ lora }: { lora: LoraView }) {
  if (lora.status === "ready") return <Badge tone="green">ready</Badge>;
  if (lora.status === "failed") return <Badge tone="red">failed</Badge>;
  const ph = trainingPhase(lora);
  return <Badge tone={ph.onGpu ? "blue" : "neutral"}>{ph.badge}</Badge>;
}

function LoraCard({ lora, now, onDelete, deleting }: { lora: LoraView; now: number; onDelete: () => void; deleting: boolean }) {
  const p = lora.progress;
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{lora.name}</h3>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{lora.trigger}</code>
        <StatusBadge lora={lora} />
        <span className="ml-auto text-[11px] text-subtle">{ago(lora.createdAt)}</span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {lora.imageIds.slice(0, 4).map((id) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={id} src={`/api/media/${id}`} alt="" loading="lazy" className="aspect-square w-full rounded-md border border-border object-cover" />
        ))}
      </div>
      {lora.status === "training" && (
        <div className="space-y-1.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-accent transition-all" style={{ width: `${p ? (100 * p.step) / p.total_steps : 2}%` }} />
          </div>
          <p className="flex justify-between font-mono text-[11px] text-subtle">
            <span>{trainingPhase(lora).detail}</span>
            <span>{now ? secs(now - lora.createdAt, 0) : ""}</span>
          </p>
        </div>
      )}
      {lora.status === "failed" && <Notice tone="error" title="Training failed">{lora.error}</Notice>}
      {lora.status !== "training" && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <dt className="text-subtle">GPU</dt>
          <dd className="text-right sm:text-left">{shortGpu(lora.gpu)}</dd>
          <dt className="text-subtle"><Term term="execution">GPU time</Term></dt>
          <dd className="text-right font-mono sm:text-left">{secs(lora.executionMs, 0)}</dd>
          <dt className="text-subtle"><Term term="cost">Cost</Term></dt>
          <dd className="text-right font-mono sm:text-left">{usd(lora.costUsd)}</dd>
          <dt className="text-subtle">Steps · loss</dt>
          <dd className="text-right font-mono sm:text-left">
            {lora.steps}
            {lora.finalLoss !== undefined ? ` · ${lora.finalLoss.toFixed(3)}` : ""}
          </dd>
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        {lora.status === "ready" && (
          <Link href={`/?lora=${lora.id}`} className={buttonClass("primary", "sm")}>
            <Sparkles className="h-3.5 w-3.5" /> Use in Studio
          </Link>
        )}
        {lora.status === "ready" && (
          <a href={`/api/loras/${lora.id}/file`} className={buttonClass("secondary", "sm")}>
            .safetensors{lora.bytes ? ` · ${(lora.bytes / 2 ** 20).toFixed(0)} MB` : ""}
          </a>
        )}
        {lora.status !== "training" &&
          (confirm ? (
            <>
              <Button size="sm" variant="danger" loading={deleting} icon={<Trash2 className="h-3.5 w-3.5" />} onClick={onDelete}>
                Delete permanently
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirm(true)}>
              Delete…
            </Button>
          ))}
      </div>
    </div>
  );
}

export default function FineTune() {
  const [view, setView] = useState<LorasView | null>(null);
  const [images, setImages] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [triggerTouched, setTriggerTouched] = useState(false);
  const [preset, setPreset] = useState<Preset>("standard");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const { code, setCode, remember } = useAccessCode();
  const toast = useToast();

  const load = useCallback(async () => {
    const res = await getJson<LorasView>("/api/loras");
    if (res.ok) {
      setView(res.data);
      setError(null);
    } else setError(res.error ?? "Couldn't load the LoRAs.");
  }, []);

  const training = view?.loras.some((l) => l.status === "training") ?? false;
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, training ? 5000 : 30000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, training]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = training ? setInterval(tick, 1000) : undefined;
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [training]);

  useEffect(() => {
    getJson<MediaView>("/api/media").then((res) => res.ok && setImages(res.data.items.filter((i) => (i.kind ?? "image") === "image")));
  }, []);

  const limits = view?.limits;
  const steps = view?.presets[preset] ?? 800;
  const estS = steps * EST_S_PER_STEP + EST_OVERHEAD_S;
  const q = query.trim().toLowerCase();
  const shown = (images ?? []).filter((i) => i.prompt.toLowerCase().includes(q));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : limits && s.length >= limits.maxImages ? s : [...s, id]));
  const enoughImages = !!limits && selected.length >= limits.minImages;
  const effectiveTrigger = triggerTouched ? trigger : triggerFrom(name);
  const canStart = !!view?.enabled && !training && enoughImages && !!name.trim() && !!effectiveTrigger && !!code;

  async function start() {
    setStarting(true);
    remember(code);
    const res = await getJson<LoraView>("/api/loras", {
      method: "POST",
      headers: { "content-type": "application/json", "x-access-code": code },
      body: JSON.stringify({ name, trigger: effectiveTrigger, imageIds: selected, steps }),
    });
    setStarting(false);
    if (!res.ok) {
      toast("error", res.error ?? "Couldn't start the training.");
      return;
    }
    toast("success", "Training started");
    setSelected([]);
    load();
  }

  async function remove(id: string) {
    setDeleting(id);
    remember(code);
    const res = await getJson(`/api/loras/${id}`, { method: "DELETE", headers: { "x-access-code": code } });
    setDeleting(null);
    if (!res.ok) toast("error", res.error ?? "Couldn't delete it.");
    load();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GraduationCap className="h-6 w-6 text-accent" /> Fine-tune
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-subtle">
          Teach FLUX.1-dev a style, product or character from your library: pick {limits?.minImages ?? 4}-{limits?.maxImages ?? 40} images, and a{" "}
          <Term term="lora">LoRA</Term> is trained on a Runpod Serverless GPU. Then put its trigger word in a prompt in the Studio.
        </p>
      </header>

      {error && <Notice tone="error" title="Couldn't load the LoRAs">{error}</Notice>}
      {view && !view.enabled && (
        <Notice tone="warn" title="Fine-tuning isn't enabled on this deployment">
          It needs a training endpoint (RUNPOD_TRAIN_ENDPOINT_ID) and a public URL the GPU workers can reach this app at.
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Card title="Train a LoRA">
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs text-subtle">Name</span>
                <input className="input w-full" placeholder="e.g. Europa covers" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-subtle">
                  <Term term="trigger">Trigger word</Term>
                </span>
                <input
                  className="input w-full font-mono"
                  placeholder="europa_covers"
                  value={effectiveTrigger}
                  maxLength={24}
                  onChange={(e) => {
                    setTriggerTouched(true);
                    setTrigger(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
                  }}
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="mb-1.5 block text-xs text-subtle">Training length</span>
                <Segmented
                  label="Training length"
                  value={preset}
                  onChange={setPreset}
                  options={(Object.keys(PRESET_LABEL) as Preset[]).map((p) => ({ value: p, label: `${PRESET_LABEL[p]} · ${view?.presets[p] ?? "…"}` }))}
                />
              </div>
              <p className="text-right font-mono text-[11px] text-subtle">
                ≈ {Math.round(estS / 60)} min GPU · ≈ {usd(estS * EST_USD_PER_S)} <span className="font-sans">(estimate from a measured run; plus queue time)</span>
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-subtle">
                  Training images: <b className={enoughImages ? "text-foreground" : ""}>{selected.length}</b> selected (min {limits?.minImages ?? 4}). Each image&apos;s
                  prompt becomes its caption, after the trigger word.
                </span>
                <div className="relative w-full sm:w-56">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
                  <input className="input h-8 w-full py-1 pl-8 text-xs" placeholder="Filter by prompt" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter images" />
                </div>
              </div>
              {images && images.length === 0 ? (
                <EmptyState icon={<Images className="h-7 w-7" />} title="No images yet">
                  Generate a few in the <Link href="/" className="text-accent hover:underline">Studio</Link> first.
                </EmptyState>
              ) : (
                <div className="grid max-h-[26rem] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5">
                  {shown.map((item) => {
                    const on = selected.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => toggle(item.id)}
                        aria-pressed={on}
                        title={item.prompt}
                        className={`relative overflow-hidden rounded-lg border-2 transition ${on ? "border-accent" : "border-transparent opacity-80 hover:opacity-100"}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/media/${item.id}`} alt={item.prompt} loading="lazy" className="aspect-square w-full object-cover" />
                        {on && (
                          <span className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white">
                            <Check className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center">
              <input
                className="input flex-1"
                type="password"
                placeholder="Access code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-label="Access code"
                autoComplete="off"
              />
              <Button variant="primary" size="lg" loading={starting} disabled={!canStart} icon={<GraduationCap className="h-4 w-4" />} onClick={start}>
                {training ? "Another LoRA is in progress…" : "Start training"}
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Your LoRAs" actions={limits && <span className="text-[11px] text-subtle">{limits.dailyCap} trainings/day</span>}>
          {!view ? (
            <p className="text-sm text-subtle">Loading…</p>
          ) : view.loras.length === 0 ? (
            <EmptyState icon={<GraduationCap className="h-7 w-7" />} title="No LoRAs yet">
              Pick images on the left and start a training. 800 steps took 11 minutes of GPU time (about $0.32), plus a few minutes waiting for a GPU.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {view.loras.map((l) => (
                <LoraCard key={l.id} lora={l} now={now} deleting={deleting === l.id} onDelete={() => remove(l.id)} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
