# Architecture

```mermaid
flowchart LR
    subgraph Client
        B[Browser]
        C[curl / Postman / bench.py]
    end

    subgraph Pod["Runpod CPU pod (cpu3c, EU-RO-1)"]
        A["Next.js app<br/>access code · rate limit · daily cap"]
        V[("Network volume 10 GB<br/>jobs.jsonl · media.jsonl · images/")]
        A --- V
    end

    subgraph SL["Runpod Serverless endpoint y6hj5mx4y5b2su"]
        Q[[Queue + autoscaler<br/>min 0 · max 2 · idle 60 s · FlashBoot]]
        W1["Worker: handler.py<br/>FLUX.1-dev BF16<br/>L40 / L40S / 6000 Ada / A40 / A6000"]
        W2[Worker 2]
        Q --> W1
        Q --> W2
    end

    S[(Runpod Secrets<br/>API key · access code)]
    R[(Docker Hub, private<br/>flux-worker:v0.2.0<br/>30.6 GB, weights baked)]

    B -- "/api/generate · /api/bulk<br/>/api/jobs/:id · /api/media" --> A
    A -- "POST /run · GET /status · /health<br/>REST v2 config" --> Q
    C -- "POST /runsync or /run" --> Q
    S -. injected at start .-> A
    R -. image pull per new host .-> W1
```

## Request flow (one image)

1. The browser posts the prompt and access code to `/api/generate`. The Runpod API key exists only on the
   app server, injected from a Runpod Secret.
2. The app checks the code, the per-visitor rate limit and the daily cap, then calls Runpod `POST /run`.
   Async `/run` (not `/runsync`) so queue time and step progress are visible and long cold starts can't
   time out the HTTP call.
3. Runpod queues the job. If no worker is warm, the autoscaler (queue-delay rule, 4 s) starts one:
   FlashBoot resume, or a fresh container that loads the weights baked into the image.
4. `handler.py` validates the input, runs `FluxPipeline`, sends `progress_update` every second, and returns
   the image plus `timings` and a `worker` block (GPU, cold start, model load time, peak VRAM).
5. The browser polls `/api/jobs/:id`; the app proxies Runpod `/status`, prices the job from
   `executionTime × GPU $/s`, saves the image to the library on the network volume, and records the job.

## Worker image layers

`deps` (pytorch 2.14.1 / CUDA 12.6 runtime + pinned Python deps) → `weights` (33.7 GB, downloaded at build
time with the HF token as a BuildKit secret) → `final` (`handler.py`). A handler change re-pushes a few KB;
v0.1.0 → v0.2.0 pushed in about 5 s. A `check` stage (deps + handler, no weights) is what CI builds.
