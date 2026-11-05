# Benchmarks

All numbers are measured on the deployed endpoint (`y6hj5mx4y5b2su`) on 3 Nov 2026 and come from the raw
files in [`bench/results/`](../bench/results) (one JSON line per job) or [`docs/examples/`](examples).
Regenerate the table with:

```bash
python bench/bench.py report bench/results/*.jsonl
```

## Warm throughput: 1024×1024, 28 steps, BF16

| Scenario | Size, steps | GPU | Jobs (ok/cold) | delayTime p50 / max (s) | executionTime p50 / p90 (s) | Inference p50 (s) | Client wall p50 (s) | $ / image |
|---|---|---|---|---|---|---|---|---|
| v0.1.0-seq-1024 (warm, GPU not reported) | 1024×1024, 28 | ? | 21/21 (0 cold) | 0.1 / 34.7 | 23.8 / 24.1 | 23.2 | 25.1 | – |
| v0.2.0-seq-1024 | 1024×1024, 28 | NVIDIA RTX 6000 Ada Generation | 8/8 (1 cold) | 0.1 / 93.3 | 21.9 / 22.2 | 21.4 | 23.9 | $0.0107 |

Cost = executionTime × list price ([runpod.io/pricing](https://www.runpod.io/pricing), checked 2026-11-03,
[`bench/prices.yaml`](../bench/prices.yaml)). It excludes idle-timeout time, which is billed while a warm
worker waits for the next job.

- `delayTime` / `executionTime` are Runpod's own numbers from `/status`; client wall time is measured by
  `bench/bench.py` (submit → result, 1 s polling).
- The v0.1.0 run was served by a worker started before the template moved to v0.2.0 (template changes don't
  replace warm workers), so it lacks the per-job `worker` block. Billing showed the Ada pool rate during it.
- Peak VRAM: **33.8 GB of 47.4 GB** on every job: BF16 FLUX.1-dev fits a 48 GB card without offloading.
- Encoding a 1024² PNG takes 0.23–0.35 s; the base64 PNG payload averages **1.34 MB** per image (why the
  app asks for JPEG).

## Cold start: what the first request pays

| Situation | `delayTime` | Where it comes from |
|---|---|---|
| Warm worker (within the 60 s idle timeout) | **0.13–0.14 s** | v0.2.0 run, jobs 1–7 (0.18 s in the v0.1.0 run) |
| FlashBoot resume of a stopped worker | **34.7 s** | v0.1.0 run, job 0 |
| New worker, image already cached on the host | **93.3 s** | v0.2.0 run, job 0 |
| New worker on a host that never pulled the 30.6 GB image | **690.6 s** | [`docs/examples/cold-512.json`](examples/cold-512.json) |

Inside the 93.3 s case the worker reported `process_ready_s` = **15.5 s** from container start to handler
ready, of which **8.1 s** is loading FLUX into GPU memory. The remaining ~78 s was Runpod-side (placing the
worker, pulling the small v0.2.0 code layer, waiting for GPU capacity).

On fresh hosts the 33.7 GB weights layer took **~7 min** (first host: 6 min 54 s from the start of the pull to the model loaded, per the worker log) and **>10 min**
(a slower host) to download. That variance is the cost of baking 33.7 GB of weights (30.6 GB compressed image) into the image, and the
reason the next experiment is Runpod model caching (see the README's next steps).

## Spot checks from the hosted app

| GPU | executionTime | Cost | Notes |
|---|---|---|---|
| NVIDIA A40 (AMPERE_48, $1.22/h) | 27.7 s | $0.0094 | single warm job; slower than the RTX 6000 Ada but cheaper per image |

One sample only; a proper per-GPU comparison needs a pinned-pool run of each.
