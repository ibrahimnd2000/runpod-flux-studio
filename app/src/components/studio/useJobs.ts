"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { TERMINAL, type GenerateInput, type JobView } from "@/lib/types";

import { getJson, isTransient } from "../api";

export type Problem = { tone: "warn" | "error"; title: string; detail?: string };

// Keep polling through short outages (pod restart, proxy hiccup) for about a minute.
const MAX_POLL_FAILURES = 60;

function submitProblem(status: number, error?: string): Problem {
  const title =
    status === 401
      ? "Access code not accepted"
      : status === 429
        ? "Limit reached"
        : status === 400
          ? "Check the request"
          : "Couldn't start the job";
  return { tone: "error", title, detail: error };
}

/** One generation: submit via /api/generate, then poll /api/jobs/[id] every second. */
export function useSingleJob(onFinished: (job: JobView) => void) {
  const [job, setJob] = useState<JobView | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const poll = useCallback(
    async function poll(id: string, failures = 0) {
      const res = await getJson<JobView>(`/api/jobs/${id}`);
      if (!res.ok) {
        if (isTransient(res.status) && failures < MAX_POLL_FAILURES) {
          setProblem({
            tone: "warn",
            title: "Lost contact with the app server, still trying",
            detail: `${res.error} The job keeps running on Runpod. Attempt ${failures + 1}/${MAX_POLL_FAILURES}.`,
          });
          timer.current = setTimeout(() => poll(id, failures + 1), 1000);
          return;
        }
        setProblem({
          tone: "error",
          title: res.status === 404 ? "This job is no longer tracked" : "Couldn't get the job status",
          detail:
            res.status === 404
              ? "The app restarted while the job was running. The image may still have been generated on Runpod; try again."
              : res.error,
        });
        setBusy(false);
        return;
      }
      const view = res.data;
      setProblem(null);
      setJob(view);
      if (view.output?.image) setImage(view.output.image);
      if (TERMINAL.includes(view.status)) {
        setBusy(false);
        if (view.status !== "COMPLETED" || view.error) {
          setProblem({
            tone: "error",
            title: `The job ${view.status === "COMPLETED" ? "returned an error" : view.status.toLowerCase().replace("_", " ")}`,
            detail: view.error ?? "No error message was returned.",
          });
        }
        onFinished(view);
      } else {
        timer.current = setTimeout(() => poll(id), 1000);
      }
    },
    [onFinished],
  );

  const submit = useCallback(
    async (input: Partial<GenerateInput>, code: string) => {
      if (timer.current) clearTimeout(timer.current);
      setProblem(null);
      setImage(null);
      setJob(null);
      setBusy(true);
      const res = await getJson<{ id: string; status: JobView["status"]; input: GenerateInput }>("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-access-code": code },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        setProblem(submitProblem(res.status, res.error));
        setBusy(false);
        return;
      }
      setJob({ id: res.data.id, status: res.data.status, submittedAt: Date.now(), input: res.data.input });
      poll(res.data.id);
    },
    [poll],
  );

  return { job, image, problem, busy, submit };
}

export interface BulkJob {
  id: string | null;
  input: GenerateInput;
  view?: JobView;
  image?: string;
  error?: string;
  failures: number;
}

export interface BulkRun {
  submittedAt: number;
  jobs: BulkJob[];
}

export const isBulkJobDone = (j: BulkJob) => !j.id || !!j.error || (!!j.view && TERMINAL.includes(j.view.status));

const BULK_POLL_MS = 1500;
const MAX_BULK_POLL_FAILURES = 40;

/** A bulk run: submit via /api/bulk, then one poller refreshes every unfinished job. */
export function useBulkRun(onFinished: () => void) {
  const [run, setRun] = useState<BulkRun | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(0);
  const runRef = useRef<BulkRun | null>(null);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const running = !!run && !run.jobs.every(isBulkJobDone);

  useEffect(() => {
    if (!running) return;
    const tick = setInterval(async () => {
      setNow(Date.now());
      const current = runRef.current;
      if (!current) return;
      const updates = await Promise.all(
        current.jobs.map(async (j): Promise<BulkJob> => {
          if (isBulkJobDone(j)) return j;
          const res = await getJson<JobView>(`/api/jobs/${j.id}`);
          if (!res.ok) {
            const failures = j.failures + 1;
            if (isTransient(res.status) && failures < MAX_BULK_POLL_FAILURES) return { ...j, failures };
            return { ...j, failures, error: res.error ?? "Lost track of this job." };
          }
          const view = res.data;
          return {
            ...j,
            failures: 0,
            view,
            image: view.output?.image ?? j.image,
            error:
              TERMINAL.includes(view.status) && (view.status !== "COMPLETED" || view.error)
                ? (view.error ?? view.status.toLowerCase())
                : undefined,
          };
        }),
      );
      setRun((r) => (r && r.submittedAt === current.submittedAt ? { ...r, jobs: updates } : r));
      if (updates.every(isBulkJobDone)) onFinished();
    }, BULK_POLL_MS);
    return () => clearInterval(tick);
  }, [running, onFinished]);

  const submit = useCallback(async (body: Record<string, unknown>, code: string) => {
    setProblem(null);
    setSubmitting(true);
    const res = await getJson<{ jobs: { id: string | null; input: GenerateInput; error?: string }[] }>("/api/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-access-code": code },
      body: JSON.stringify(body),
    });
    setSubmitting(false);
    if (!res.ok) {
      setProblem(submitProblem(res.status, res.error));
      return;
    }
    setNow(Date.now());
    setRun({
      submittedAt: Date.now(),
      jobs: res.data.jobs.map((j) => ({ id: j.id, input: j.input, error: j.error, failures: 0 })),
    });
  }, []);

  return { run, problem, submitting, running, now, submit };
}
