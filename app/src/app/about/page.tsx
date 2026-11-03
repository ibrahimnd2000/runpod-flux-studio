import { ArrowRight, Cpu, Globe, Inbox, Server, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";

import { GLOSSARY, type GlossaryKey } from "@/components/glossary";
import { Card } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "How it works" };

const FLOW = [
  { icon: Globe, title: "Your browser", body: "Sends the prompt and access code to this app. It never sees the Runpod API key." },
  {
    icon: ShieldCheck,
    title: "App server (CPU pod)",
    body: "Checks the access code and limits, then calls Runpod /run with a key held in Runpod Secrets. Polls /status for you.",
  },
  {
    icon: Inbox,
    title: "Runpod queue",
    body: "Holds the job until a GPU worker is free. With none warm, the autoscaler starts one: that wait is the cold start.",
  },
  {
    icon: Cpu,
    title: "GPU worker",
    body: "Runs FLUX.1-dev in BF16 on a 48 GB GPU, reports step progress, and returns the image with its timings, GPU and cost data.",
  },
];

const SECTIONS: { title: string; terms: [GlossaryKey, string][] }[] = [
  {
    title: "Making an image",
    terms: [
      ["prompt", "Prompt"],
      ["aspect", "Aspect ratio"],
      ["steps", "Steps"],
      ["guidance", "Guidance"],
      ["seed", "Seed"],
      ["variations", "Variations"],
      ["bulk", "Bulk generation"],
    ],
  },
  {
    title: "Reading the timings",
    terms: [
      ["queue", "Queue time"],
      ["coldStart", "Cold start"],
      ["execution", "Execution (GPU) time"],
      ["inference", "Inference"],
      ["encode", "Encode"],
      ["network", "Network + polling"],
      ["cost", "Cost"],
      ["speedup", "Speed-up"],
      ["vram", "Peak VRAM"],
    ],
  },
  {
    title: "The GPU endpoint",
    terms: [
      ["workers", "Workers"],
      ["running", "Active worker"],
      ["idle", "Idle (cached) worker"],
      ["initializing", "Initializing"],
      ["throttled", "Throttled"],
      ["unhealthy", "Unhealthy"],
      ["autoscaling", "Autoscaling"],
      ["idleTimeout", "Idle timeout"],
      ["flashboot", "FlashBoot"],
      ["gpuPool", "GPU pool"],
      ["excluded", "Excluded GPUs"],
      ["accessCode", "Access code"],
    ],
  },
];

export default function About() {
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">How it works</h1>
        <p className="mt-1 text-sm text-subtle">
          What happens between pressing Generate and seeing the image, and what every number in the Studio means.
        </p>
      </div>

      <Card title={<span className="flex items-center gap-2"><Server className="h-4 w-4 text-subtle" /> Request flow</span>}>
        <ol className="grid gap-3 md:grid-cols-4">
          {FLOW.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="relative rounded-xl border border-border bg-background/50 p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="font-mono text-xs text-subtle">{i + 1}</span>
              </div>
              <h3 className="text-sm font-medium">{title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-subtle">{body}</p>
              {i < FLOW.length - 1 && (
                <ArrowRight className="absolute top-1/2 -right-3 z-10 hidden h-4 w-4 -translate-y-1/2 text-subtle md:block" />
              )}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-subtle">
          The image then comes back the same way. The app saves a copy to its library on a Runpod network volume.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {SECTIONS.map((s) => (
          <Card key={s.title} title={s.title}>
            <dl className="space-y-3.5">
              {s.terms.map(([key, label]) => (
                <div key={key}>
                  <dt className="text-sm font-medium">{label}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-subtle">{GLOSSARY[key]}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
    </div>
  );
}
