# Architecture

```mermaid
flowchart LR
    subgraph Client
        B[Browser]
        C[curl / Postman / bench.py]
    end

    subgraph Pod["Runpod CPU pod (cpu3c, EU-RO-1)"]
        A["Next.js app<br/>access code · rate limit · daily cap"]
        V[("Network volume 10 GB<br/>job, media, video, LoRA, run and battle<br/>records (JSONL) · images/ · loras/")]
        A --- V
    end

    subgraph SL["Runpod Serverless endpoint y6hj5mx4y5b2su"]
        Q[[Queue + autoscaler<br/>min 0 · max 1 · idle 60 s · FlashBoot]]
        W1["Worker: handler.py<br/>FLUX.1-dev BF16 (+ LoRA)<br/>L40 / L40S / 6000 Ada / A40 / A6000"]
        Q --> W1
    end

    subgraph TR["LoRA training endpoint eu4cak6ivq2uep"]
        TW["Same image, task train_lora<br/>max 1 · 1 h timeout"]
    end

    S[(Runpod Secrets<br/>API key · access code)]
    R[(Docker Hub, private<br/>flux-worker:v0.3.1<br/>30.6 GB, weights baked)]

    B -- "/api/generate · /api/bulk<br/>/api/jobs/:id · /api/media" --> A
    A -- "POST /run · GET /status · /health<br/>REST v2 config" --> Q
    C -- "POST /runsync or /run" --> Q
    S -. injected at start .-> A
    R -. image pull per new host .-> W1
    R -.-> TW
    A -- "train_lora job" --> TW
    TW -- "PUT adapter, one-time token" --> A
    W1 -- "GET /api/loras/:id/file" --> A
```

The [Fine-tuning](../README.md#fine-tuning-flux-loras) section of the README explains the LoRA data path.

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
time with the HF token as a BuildKit secret) → `final` (training deps, then `handler.py` and `lora_train.py`). A
handler change re-pushes a few KB; v0.1.0 → v0.2.0 pushed in about 5 s. A `check` stage (deps + code, no
weights) is what CI builds.

## Video endpoints (Wan 2.2, LTX-2.5)

`Animate` in the app posts a **library image id** to `/api/animate`; the app reads the image from its network
volume, sends it as a data URI to the video endpoint's `/run`, and polls `/status`. On completion the base64 MP4
from the job result is written to the library once and served from `/api/media/:id` with HTTP range support.
Jobs nobody is watching (dialog closed during a long cold start) are finished by the library's list route, so
clips still land in the library.

The video worker image is 8 GB with no weights and serves both families (`VIDEO_MODEL`): Runpod model caching
mounts the snapshot (about 34 GB for Wan 2.2, 72 GB for LTX-2.5) at
`/runpod/model-store/huggingface/<org>/<name>/<revision>`, and the handler loads it from there (`OFFLOAD=model`
keeps components on the GPU only while they run). Two endpoints: Wan 2.2 on the same 48 GB pools as FLUX (the
app's default), LTX-2.5 on 80 GB+ pools. Clips have their own daily cap in the app.

## Orchestration (pipelines, agents, battles)

Runs execute inside the app pod (`app/src/lib/agents/`), not in the browser. The browser starts a run, gets an
id, and polls `/api/runs/:id?after=<seq>` for new trace events; a run keeps going if the tab closes.

```mermaid
flowchart LR
    UI[Pipelines · Agent · Battleground pages] -->|start| R[Run store<br/>memory + agent-runs.jsonl]
    R --> P[Pipeline executor<br/>DAG, fan-out]
    R --> AG[Agent loop]
    AG -->|turn| L{LLM adapter}
    L --> CL[Claude<br/>Anthropic SDK]
    L --> VL[Qwen3-8B<br/>Runpod vLLM]
    L --> SC[Scripted baseline]
    AG -->|tool calls| T[Tools + budget check]
    P --> T
    T --> G[gpu.ts: same submit/poll code,<br/>limits and library as the Studio]
    G --> IMG[[FLUX endpoint]]
    G --> VID[[Wan / LTX endpoints]]
    B[Battle] -->|2 agent runs| AG
    B -->|deliveries + spend| J[Claude judge] --> E[Elo leaderboard<br/>battles.jsonl]
```

- **Budget per run:** dollars (GPU at measured or Runpod-reported cost, plus LLM tokens), images, clips, turns.
  Tools check it before submitting and reserve the estimate in the same step, so parallel tool calls can't
  overspend; a refusal is a tool error the model reads.
- **Same limits as the Studio:** agent image and video jobs go through the access code, per-visitor rate limit
  and daily caps; at most 4 runs at once and 40 per day.
- **Dry run:** GPU tools save placeholder media priced at the measured averages, so a whole flow (including the
  LLM) can be demonstrated without any GPU.
