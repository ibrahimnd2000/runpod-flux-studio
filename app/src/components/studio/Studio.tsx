"use client";

import { useCallback, useEffect, useState } from "react";

import type { HistoryView, JobView } from "@/lib/types";

import { getJson } from "../api";
import { useEndpoint } from "../EndpointProvider";
import { Card } from "../ui/primitives";
import { celebrate } from "../fun/EasterEggs";
import { useToast } from "../ui/Toaster";
import { useAccessCode } from "../useAccessCode";
import BulkResults from "./BulkResults";
import Composer, { ASPECTS, bulkPrompts, DEFAULT_SETTINGS, type Aspect, type Settings } from "./Composer";
import EndpointCard from "./EndpointCard";
import AnimateDialog, { type AnimateSource } from "../video/AnimateDialog";
import RecentRuns from "./RecentRuns";
import SingleResult from "./SingleResult";
import { useBulkRun, useSingleJob } from "./useJobs";

export default function Studio() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const set = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const { code, setCode, remember } = useAccessCode();
  const [history, setHistory] = useState<HistoryView | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const { refresh: refreshEndpoint } = useEndpoint();
  const toast = useToast();

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
    const first = setTimeout(loadHistory, 0);
    const t = setInterval(loadHistory, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [loadHistory]);

  const onFinished = useCallback(() => {
    loadHistory();
    refreshEndpoint();
  }, [loadHistory, refreshEndpoint]);

  const onSingleFinished = useCallback(
    (job: JobView) => {
      onFinished();
      if (job.status === "COMPLETED" && !job.error) {
        if (job.output?.seed === 42) {
          toast("success", "Seed 42: the answer to life, the universe and product photography.");
          celebrate();
        } else {
          toast("success", "Image ready · saved to the library");
        }
      }
    },
    [onFinished, toast],
  );
  const onBulkFinished = useCallback(() => {
    onFinished();
    toast("success", "Bulk run finished · images saved to the library");
  }, [onFinished, toast]);

  const single = useSingleJob(onSingleFinished);
  const bulk = useBulkRun(onBulkFinished);

  const [animate, setAnimate] = useState<AnimateSource | null>(null);
  const closeAnimate = useCallback(() => setAnimate(null), []);

  const size = ASPECTS[settings.aspect];
  const limits = history?.limits;

  function generate() {
    remember(code);
    const common = { width: size.w, height: size.h, num_inference_steps: settings.steps, guidance_scale: settings.guidance };
    if (settings.mode === "bulk") {
      bulk.submit({ ...common, prompts: bulkPrompts(settings), variations: settings.variations }, code);
      return;
    }
    // Unlocked seed: let the worker pick one (it returns the seed it used).
    const seed = settings.seedLocked && settings.seed !== "" ? Number(settings.seed) : undefined;
    single.submit({ ...common, prompt: settings.prompt, seed }, code);
  }

  function reuse(job: JobView) {
    const aspect =
      (Object.keys(ASPECTS) as Aspect[]).find((a) => ASPECTS[a].w === job.input.width && ASPECTS[a].h === job.input.height) ??
      settings.aspect;
    set({
      mode: "single",
      prompt: job.input.prompt,
      aspect,
      steps: job.input.num_inference_steps,
      guidance: job.input.guidance_scale,
      seed: String(job.output?.seed ?? ""),
      seedLocked: true,
    });
    toast("success", "Settings and seed loaded: edit the prompt and generate again");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Studio</h1>
        <p className="mt-1 text-sm text-subtle">
          Product photos from a text prompt with FLUX.1-dev on a Runpod Serverless GPU. Every request shows where its
          time and money went.
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Card>
            <Composer
              settings={settings}
              set={set}
              code={code}
              setCode={setCode}
              maxSteps={limits?.maxSteps ?? 28}
              bulkMax={limits?.bulkMax ?? 8}
              busy={settings.mode === "bulk" ? bulk.submitting || bulk.running : single.busy}
              onGenerate={generate}
            />
          </Card>
          <Card title={settings.mode === "bulk" ? "Bulk run" : "Result"}>
            {settings.mode === "bulk" ? (
              <BulkResults run={bulk.run} now={bulk.now} problem={bulk.problem} />
            ) : (
              <SingleResult
                job={single.job}
                image={single.image}
                problem={single.problem}
                onReuse={reuse}
                // The image job id is also its library id (saved on completion).
                onAnimate={
                  limits?.videoEnabled
                    ? (job, image) => setAnimate({ id: job.id, prompt: job.input.prompt, url: image })
                    : undefined
                }
              />
            )}
          </Card>
          <RecentRuns h={history} error={historyError} />
        </div>
        <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <EndpointCard />
          {limits?.videoEnabled && <EndpointCard which="video" />}
        </div>
      </div>
      {animate && <AnimateDialog source={animate} onClose={closeAnimate} />}
    </div>
  );
}
