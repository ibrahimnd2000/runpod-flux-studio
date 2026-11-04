"use client";

import { Dice5, GraduationCap, Layers, Lock, RectangleHorizontal, RectangleVertical, Sparkles, Square, Unlock } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

import type { LoraView } from "@/lib/types";

import { Button, Segmented, Slider } from "../ui/primitives";
import { Term } from "../ui/Tooltip";

export const PRESETS = [
  { label: "Coffee mug", prompt: "A studio product photo of a ceramic coffee mug on a walnut table, soft morning light, shallow depth of field" },
  { label: "Running shoes", prompt: "A pair of white running shoes on a concrete plinth, hard rim light, minimalist product shot" },
  { label: "Olive oil", prompt: "A glass bottle of olive oil beside fresh rosemary on linen, overhead flat lay, natural light" },
  { label: "Backpack", prompt: "A leather backpack hanging on a wooden peg against a sage green wall, catalogue photo" },
  { label: "Perfume", prompt: "A minimalist perfume bottle on wet black stone, dramatic side light, water droplets, luxury advertising" },
];

// Width x height per aspect, multiples of 16 and within the demo's 1024 px limit.
export const ASPECTS = {
  "1:1": { w: 1024, h: 1024, icon: Square, title: "Square · 1024×1024" },
  "4:5": { w: 816, h: 1024, icon: RectangleVertical, title: "Portrait (Instagram) · 816×1024" },
  "3:2": { w: 1024, h: 688, icon: RectangleHorizontal, title: "Landscape · 1024×688" },
  "16:9": { w: 1024, h: 576, icon: RectangleHorizontal, title: "Widescreen · 1024×576" },
  "9:16": { w: 576, h: 1024, icon: RectangleVertical, title: "Story · 576×1024" },
} as const;
export type Aspect = keyof typeof ASPECTS;

export interface Settings {
  mode: "single" | "bulk";
  prompt: string;
  prompts: string;
  variations: number;
  aspect: Aspect;
  steps: number;
  guidance: number;
  seed: string;
  seedLocked: boolean;
  /** A ready LoRA's id, or "" for plain FLUX. */
  lora: string;
  loraScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "single",
  prompt: PRESETS[0].prompt,
  prompts: PRESETS.slice(0, 4).map((p) => p.prompt).join("\n"),
  variations: 2,
  aspect: "1:1",
  steps: 28,
  guidance: 3.5,
  seed: "",
  seedLocked: false,
  lora: "",
  loraScale: 1,
};

export const bulkPrompts = (s: Settings) => s.prompts.split("\n").map((p) => p.trim()).filter(Boolean);

export default function Composer({
  settings,
  set,
  code,
  setCode,
  maxSteps,
  bulkMax,
  busy,
  onGenerate,
  loras = [],
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  code: string;
  setCode: (c: string) => void;
  maxSteps: number;
  bulkMax: number;
  busy: boolean;
  onGenerate: () => void;
  /** Ready LoRAs; the picker only shows when there is at least one. */
  loras?: LoraView[];
}) {
  const lora = loras.find((l) => l.id === settings.lora);
  const promptText = settings.mode === "single" ? settings.prompt : settings.prompts;
  const missingTrigger = !!lora && !promptText.toLowerCase().includes(lora.trigger);
  const form = useRef<HTMLFormElement>(null);
  const bulkCount = bulkPrompts(settings).length * settings.variations;
  const tooMany = settings.mode === "bulk" && bulkCount > bulkMax;
  const canSubmit =
    !busy && !tooMany && (settings.mode === "single" ? settings.prompt.trim().length > 0 : bulkCount > 0);

  // ⌘/Ctrl + Enter submits from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        form.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onGenerate();
      }}
      className="space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Generation mode"
          value={settings.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "single", label: <><Sparkles className="h-3.5 w-3.5" /> Single</> },
            { value: "bulk", label: <><Layers className="h-3.5 w-3.5" /> Bulk · parallel</> },
          ]}
        />
        <span className="text-xs text-subtle">
          {settings.mode === "bulk" ? <Term term="bulk">How bulk works</Term> : <Term term="prompt">Writing a prompt</Term>}
        </span>
      </div>

      {settings.mode === "single" ? (
        <div>
          <div className="relative">
            <textarea
              className="input min-h-28 resize-y pb-7 text-[15px] leading-relaxed"
              value={settings.prompt}
              maxLength={1000}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder="Describe your product shot…"
              aria-label="Prompt"
            />
            <span className="pointer-events-none absolute right-3 bottom-2 font-mono text-[11px] text-subtle">
              {settings.prompt.length}/1000
            </span>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`chip ${settings.prompt === p.prompt ? "border-accent text-accent" : ""}`}
                onClick={() => set({ prompt: p.prompt })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <textarea
            className="input min-h-36 resize-y font-mono text-xs leading-relaxed"
            value={settings.prompts}
            onChange={(e) => set({ prompts: e.target.value })}
            placeholder="One prompt per line"
            aria-label="Prompts, one per line"
          />
          <div className="mt-2.5 grid grid-cols-[1fr_auto] items-end gap-4">
            <Slider
              label={<Term term="variations">Variations per prompt</Term>}
              value={settings.variations}
              min={1}
              max={bulkMax}
              onChange={(variations) => set({ variations })}
            />
            <span className={`pb-0.5 font-mono text-xs ${tooMany ? "text-red-500" : "text-subtle"}`}>
              {bulkPrompts(settings).length} prompts × {settings.variations} = {bulkCount} / {bulkMax} images
            </span>
          </div>
        </div>
      )}

      {loras.length > 0 && (
        <div className="grid grid-cols-1 items-end gap-4 rounded-xl border border-border bg-muted/40 p-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 flex items-center gap-1.5 text-xs text-subtle">
              <GraduationCap className="h-3.5 w-3.5" /> <Term term="lora">LoRA</Term>
              <Link href="/lora" className="ml-auto text-accent hover:underline">
                train one
              </Link>
            </span>
            <select className="input w-full" value={settings.lora} onChange={(e) => set({ lora: e.target.value })} aria-label="LoRA">
              <option value="">None · plain FLUX.1-dev</option>
              {loras.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.trigger}
                </option>
              ))}
            </select>
          </label>
          {lora && (
            <Slider
              label={<Term term="loraScale">Strength</Term>}
              value={settings.loraScale}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(loraScale) => set({ loraScale })}
              format={(v) => v.toFixed(2)}
            />
          )}
          {missingTrigger && (
            <p className="text-xs text-subtle md:col-span-2">
              The prompt doesn&apos;t mention <code className="font-mono text-foreground">{lora.trigger}</code>, the word the LoRA was trained on.{" "}
              {settings.mode === "single" && (
                <button type="button" className="text-accent hover:underline" onClick={() => set({ prompt: `${lora.trigger}, ${settings.prompt}` })}>
                  Add it
                </button>
              )}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <span className="flex items-center text-xs text-subtle">
            <Term term="aspect">Aspect ratio</Term>
            <span className="ml-auto font-mono text-foreground">
              {ASPECTS[settings.aspect].w}×{ASPECTS[settings.aspect].h}
            </span>
          </span>
          <Segmented
            label="Aspect ratio"
            value={settings.aspect}
            onChange={(aspect) => set({ aspect })}
            options={(Object.keys(ASPECTS) as Aspect[]).map((a) => {
              const Icon = ASPECTS[a].icon;
              return { value: a, title: ASPECTS[a].title, label: <><Icon className="h-3.5 w-3.5" />{a}</> };
            })}
          />
        </div>
        {settings.mode === "single" && (
          <div className="space-y-2">
            <span className="text-xs text-subtle">
              <Term term="seed">Seed</Term>
            </span>
            <div className="flex gap-2">
              <input
                className="input font-mono"
                placeholder="random"
                inputMode="numeric"
                value={settings.seed}
                onChange={(e) => set({ seed: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                aria-label="Seed"
              />
              <Button
                type="button"
                size="md"
                title="Random seed"
                aria-label="Random seed"
                icon={<Dice5 className="h-4 w-4" />}
                onClick={() => set({ seed: String(Math.floor(Math.random() * 2 ** 32)), seedLocked: true })}
              />
              <Button
                type="button"
                size="md"
                variant={settings.seedLocked ? "primary" : "secondary"}
                title={settings.seedLocked ? "Seed locked: reused for every run" : "Seed unlocked: new random seed each run"}
                aria-label={settings.seedLocked ? "Unlock seed" : "Lock seed"}
                aria-pressed={settings.seedLocked}
                icon={settings.seedLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                onClick={() => set({ seedLocked: !settings.seedLocked })}
              />
            </div>
          </div>
        )}
        <Slider
          label={<Term term="steps">Steps</Term>}
          value={settings.steps}
          min={4}
          max={maxSteps}
          onChange={(steps) => set({ steps })}
          format={(v) => `${v}${v <= 12 ? " · draft" : ""}`}
        />
        <Slider
          label={<Term term="guidance">Guidance</Term>}
          value={settings.guidance}
          min={1}
          max={8}
          step={0.5}
          onChange={(guidance) => set({ guidance })}
          format={(v) => v.toFixed(1)}
        />
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <input
            className="input pr-8"
            type="password"
            placeholder="Access code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Access code"
            autoComplete="off"
          />
          <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
            <Term term="accessCode" side="left">
              {""}
            </Term>
          </span>
        </div>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!canSubmit} icon={<Sparkles className="h-4 w-4" />}>
          {settings.mode === "bulk" ? `Generate ${bulkCount} images` : "Generate"}
          <kbd className="ml-1 hidden rounded border border-white/30 px-1 font-mono text-[10px] font-normal opacity-80 sm:inline">⌘↵</kbd>
        </Button>
      </div>
    </form>
  );
}
