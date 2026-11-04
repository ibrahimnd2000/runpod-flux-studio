# FLUX Studio on Runpod Serverless

[![CI](https://github.com/ibrahimnd2000/runpod-flux-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/ibrahimnd2000/runpod-flux-studio/actions/workflows/ci.yml)

Text → product image with **FLUX.1-dev** on a **Runpod Serverless** GPU endpoint, plus a web app that shows,
for every request, where the time and money went (queue, cold start, GPU time, cost per image), video
endpoints that animate images into short clips (**Wan 2.2** and **LTX-2.5**), and an orchestration layer:
**pipelines**, **tool-calling agents** and an **agent battleground** that drive those endpoints, with the agents
running on Claude or on an open model served from a **Runpod vLLM endpoint**.

**Live demo:** https://t2jragqmgaorlq-3000.proxy.runpod.net (generating needs the access code sent with the submission)

![Studio: result with the request inspector (where the time went, GPU, cost) and the live endpoint card](docs/screenshots/studio.jpg)

```bash
# One command against the live endpoint (Runpod API key needed; see Quick start for the no-key route)
curl -s -X POST https://api.runpod.ai/v2/y6hj5mx4y5b2su/runsync \
  -H "Authorization: Bearer $RUNPOD_API_KEY" -H 'Content-Type: application/json' \
  -d '{"input":{"prompt":"A studio product photo of a ceramic coffee mug on a walnut table","seed":42}}' \
  | python3 -c 'import json,sys,base64; r=json.load(sys.stdin); open("mug.png","wb").write(base64.b64decode(r["output"]["images"][0])); print(r["status"], "→ mug.png")'
```

| What the brief asked for | Where |
|---|---|
| `handler.py` that serves the model | [`workers/image/handler.py`](workers/image/handler.py), tested in [`tests/`](tests) |
| Docker image with the handler **and the model** | [`workers/image/Dockerfile`](workers/image/Dockerfile): weights baked in (33.7 GB), private `docker.io/ibrahimnd2000/flux-worker:v0.2.0` |
| Serverless endpoint on Runpod | `y6hj5mx4y5b2su`, created by [`scripts/deploy.sh`](scripts/deploy.sh) |
| Text in → image out | [examples with the exact request and Runpod's response](docs/examples) · curl · Postman · web app |

**Extras** (beyond the brief, built on top of it): measured benchmarks and a cold-start study; a hosted Next.js
app on a Runpod CPU pod (single and parallel bulk generation, live endpoint dashboards, a media library on a
network volume, beginner tooltips); image → video endpoints with Wan 2.2 and LTX-2.5 using Runpod model caching
(see [Video](#video-image--clip-with-wan-22-and-ltx-25)); pipelines, agents and a battleground on top of all of it
(see [Orchestration](#orchestration-pipelines-agents-battleground)); LoRA fine-tuning of FLUX.1-dev on a Serverless
endpoint (see [Fine-tuning](#fine-tuning-flux-loras)); 168 automated tests in CI.

## Contents
[Results](#results) · [Quick start](#quick-start) · [API](#api) · [Video](#video-image--clip-with-wan-22-and-ltx-25) ·
[Orchestration](#orchestration-pipelines-agents-battleground) · [Fine-tuning](#fine-tuning-flux-loras) ·
[Architecture](#architecture) · [Design decisions](#design-decisions) · [Platform notes](#platform-notes) ·
[Cost and business case](#cost-and-business-case) · [Limitations and next steps](#limitations-and-next-steps) ·
[Repository](#repository)

## Results

Measured on 3 Nov 2026; raw data in [`bench/results/`](bench/results), method and more detail in
[`docs/benchmarks.md`](docs/benchmarks.md).

| 1024×1024, 28 steps, BF16 | Value |
|---|---|
| Warm GPU time per image (`executionTime`) | **21.9 s p50 · 22.2 s p90** (RTX 6000 Ada, 8 jobs) · 23.8 s p50 over 21 jobs on an earlier worker |
| Queue time on a warm worker (`delayTime`) | **0.1 s** |
| End-to-end at the client | 23.9 s p50 |
| **Cost per image** | **$0.0107** (21.9 s × $1.75/h) · $0.0094 on an A40 (single sample) |
| Peak VRAM | 33.8 GB of 48 GB: no offloading needed |

| Cold start (`delayTime` of the first request) | Measured |
|---|---|
| Worker still warm (60 s idle timeout) | 0.1 s |
| FlashBoot resume of a stopped worker | **34.7 s** |
| New worker on a host that has the image cached | **93.3 s** (container → ready 15.5 s, of which model load 8.1 s) |
| New worker on a host pulling the 30.6 GB image | **690.6 s** |

<table><tr>
<td><img src="docs/examples/warm-1024-1.png" width="260" alt="Ceramic mug, seed 42"></td>
<td><img src="docs/examples/warm-1024-2.png" width="260" alt="Ceramic mug, seed 43"></td>
<td><img src="docs/examples/warm-1024-3.png" width="260" alt="Ceramic mug, seed 44"></td>
</tr></table>

*"A studio product photo of a ceramic coffee mug on a walnut table, soft morning light, shallow depth of
field", 1024², 28 steps, seeds 42–44. Request and full response for each: [`docs/examples/`](docs/examples).*

The whole build, all tests and benchmarks cost **under $1** of GPU time.

## Quick start

### 1. Try the hosted app (no setup)

| Library (images on the app's network volume) | How it works (request flow + glossary) |
|---|---|
| ![Library](docs/screenshots/library.jpg) | ![How it works](docs/screenshots/how-it-works.jpg) |

Open the [live demo](https://t2jragqmgaorlq-3000.proxy.runpod.net), enter the access code, press
**Generate**. Switch to **Bulk · parallel** to send up to 8 images at once and watch the autoscaler spread them
over workers (the run summary shows the speed-up). Every image lands in the **Library**. Hover any ⓘ for a
plain-language explanation; *How it works* explains every number.

The same app API works from a terminal without a Runpod key:
```bash
curl -s -X POST https://t2jragqmgaorlq-3000.proxy.runpod.net/api/generate \
  -H 'Content-Type: application/json' -H "x-access-code: $CODE" \
  -d '{"prompt":"White running shoes on a concrete plinth","width":1024,"height":1024}'
# → {"id": "..."}; poll GET /api/jobs/<id> until "status": "COMPLETED"
```

### 2. Call the endpoint directly
```bash
cp .env.example .env    # set RUNPOD_API_KEY and RUNPOD_IMAGE_ENDPOINT_ID=y6hj5mx4y5b2su
set -a; source .env; set +a
scripts/generate.sh "A leather backpack on a wooden peg, catalogue photo" out/backpack.png
```
More (sync vs async, polling, health, error cases): [`scripts/curl_examples.md`](scripts/curl_examples.md).
**Postman:** import [`postman/runpod-flux.postman_collection.json`](postman/runpod-flux.postman_collection.json),
set `RUNPOD_API_KEY` and `ENDPOINT_ID`; *Run sync* renders the image in the response pane.

### 3. Run the worker locally (no GPU, no credits)
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check . && .venv/bin/pytest -q              # what CI runs (49 worker/bench tests)
(cd app && npm ci && npm test)                              # 119 app tests: fake Runpod + Anthropic, no keys

cd workers/image
MOCK_PIPELINE=1 ../../.venv/bin/python handler.py          # one job from test_input.json (SDK local mode)
MOCK_PIPELINE=1 ../../.venv/bin/python handler.py --rp_serve_api --rp_api_port 8000   # local /run, /runsync, /status
```
`MOCK_PIPELINE=1` swaps FLUX for a deterministic image generator, so validation, errors and the response shape
are testable on a laptop. The video worker works the same way (`cd workers/video && MOCK_PIPELINE=1 ...`).

### 4. Run the web app locally
```bash
cd app && npm ci
set -a; source ../.env; set +a                 # RUNPOD_API_KEY + endpoint ids (server-side only)
DEMO_ACCESS_CODE=pick-one npm run build && DEMO_ACCESS_CODE=pick-one npm start   # http://localhost:3000
```
Without `DEMO_ACCESS_CODE` the dashboards work but generating is disabled (fail closed). Without a video
endpoint id the Animate button is hidden. Without `RUNPOD_IMAGE_ENDPOINT_ID`, Pipelines / Agent / Battleground
run as dry runs (placeholder images, the scripted model), so the orchestration UI works with no keys at all.

### 5. Build and deploy your own
```bash
hf auth login                                   # account that accepted the FLUX.1-dev licence
REGISTRY_USER=<you> IMAGE_TAG=v0.2.0 scripts/build_and_push.sh    # linux/amd64, HF token as a BuildKit secret
runpodctl registry create ...                   # private repo → registry auth for Runpod
REGISTRY_AUTH_ID=<id> RUNPOD_API_KEY=... scripts/deploy.sh         # template + endpoint + GPU exclusions
python bench/bench.py run --label warm-1024 --n 20                 # benchmark → bench/results/*.jsonl
```

## API

**Input** (`job.input`)

| Field | Type | Default | Rules |
|---|---|---|---|
| `prompt` | string | required | non-empty, ≤ 1,000 chars |
| `width`, `height` | int | 1024 | clamped to 256–1536, rounded to a multiple of 16 |
| `num_inference_steps` | int | 28 | clamped to 1–50 |
| `guidance_scale` | float | 3.5 | clamped to 0–20 |
| `seed` | int | random | 0 – 2³²−1; the seed used is always returned |
| `num_images` | int | 1 | clamped to 1–4 (batched on one GPU) |
| `output` | `"base64"` \| `"url"` | `"base64"` | `url` uploads to S3-compatible storage (bucket env vars on the endpoint) |
| `image_format` | `"png"` \| `"jpeg"` | `"png"` | a base64 1024² PNG is ~1.34 MB; the app asks for JPEG |

Out-of-range values are clamped and listed in `notes`. Unknown fields, wrong types or an empty prompt return
`{"error": "..."}`, which Runpod reports as `status: FAILED`. `negative_prompt` is rejected on purpose:
FLUX.1-dev is guidance-distilled (no classifier-free guidance), so there is no negative branch to steer.

**Output** (a real response from the benchmark, job 2 on its worker)
```json
{
  "images": ["<base64>"],
  "seed": 1001,
  "timings": { "inference_ms": 20946.4, "encode_ms": 233.2, "total_ms": 21179.7 },
  "worker": {
    "id": "b16kombks5zagc", "gpu": "NVIDIA RTX 6000 Ada Generation",
    "vram_total_gb": 47.4, "peak_vram_gb": 33.8,
    "cold_start": false, "model_load_ms": 8107.7, "process_ready_s": 15.49, "jobs_served": 2
  },
  "params": { "width": 1024, "height": 1024, "num_inference_steps": 28, "guidance_scale": 3.5, "...": "..." }
}
```
The `worker` block is what makes cold starts and GPU placement visible per request. While a job runs,
`/status` returns `output: {"step": 14, "total_steps": 28}` from `runpod.serverless.progress_update`.

## Video: image → clip with Wan 2.2 and LTX-2.5

One worker image ([`workers/video/`](workers/video)), two model families selected by `VIDEO_MODEL`, two
Serverless endpoints. It turns an image, typically a FLUX output, plus a motion prompt into an MP4. In the app
it's the **Animate** button on any image, with a model picker.

| Endpoint | Model | GPUs | Notes |
|---|---|---|---|
| `wrebsusdyaz9b5` | **Wan 2.2 TI2V-5B** (`WanImageToVideoPipeline`) | 48 GB pools (same as FLUX) | silent; keeps the input's aspect ratio at the target pixel area |
| `ni76to0oacpj7o` | **LTX-2.5** (22B, distilled 8-step, `LTX2ImageToVideoPipeline`) | 80 GB pools (A100, H100) | generates a soundtrack with the video |

| Input | Default | Rules |
|---|---|---|
| `image` | required | https URL, data URI or base64; ≤ 8 MB (Runpod's `/run` limit is 10 MB) |
| `prompt` | required | the motion, e.g. "slow push-in, steam rising" |
| `resolution` | `540p` | `540p` or `720p`; LTX uses 960×544 / 1280×704 (swapped for portrait), Wan the same pixel area at the image's aspect |
| `num_frames` | 121 | snapped to 8k+1 within 9–241 (121 ≈ 5 s at 24 fps) |
| `fps` · `audio` · `seed` · `steps` | 24 · LTX only · random · Wan 30 | |

Output: `video` (base64 MP4), `bytes`, `seed`, `timings`, and the same `worker` block as the image worker. The
handler refuses results over 15 MB of base64, because Runpod doesn't document a result-size limit.

**Measured** (one clip each, 3–4 Nov 2026, so single samples, not benchmarks):

| 2 s clip (49 frames, 24 fps), 540p | Wan 2.2 TI2V-5B | LTX-2.5 |
|---|---|---|
| Output | 736×736 H.264, silent | 960×544 H.264 + AAC audio |
| GPU | RTX 6000 Ada | H100 80GB HBM3 |
| GPU time (`executionTime`) | **87.2 s** (86.1 s inference, 30 steps) | **108.4 s** (92.0 s inference, 15.7 s encode) |
| Cost | **$0.042** | **$0.162** |
| Peak VRAM | 13.8 GB | 45.9 GB |
| Wait before it started (`delayTime`) | 183 s: first worker on the endpoint, model already placed | **69 min**: queued for 80 GB GPU capacity |

That last row decided the default. LTX-2.5 looks better and has sound, but it needs 80 GB GPUs that were scarce
that evening, so a user would have waited over an hour. Wan 2.2 runs on the same plentiful 48 GB pools as FLUX
at a quarter of the cost per clip, so the app offers Wan first and LTX as the premium option.

**How it's deployed.** The weights are big (Wan 2.2 ~34 GB, LTX-2.5 ~72 GB), so these endpoints use **Runpod
model caching**: the image is 8 GB (code and dependencies only) and Runpod places the weights on hosts itself,
without billing the download. Wan isn't gated and deploys from the CLI
([`scripts/deploy_video_wan.sh`](scripts/deploy_video_wan.sh)); LTX-2.5 is gated, so that endpoint was created in
the console with the Hugging Face token as a **Runpod Secret** ([`scripts/deploy_video.sh`](scripts/deploy_video.sh)).
diffusers is pinned to a `main` commit (LTX-2.5 isn't in a release yet); CI builds the image's `check` stage,
which imports both real pipelines and the Gemma 4 encoder.

## Orchestration: pipelines, agents, battleground

Three pages in the app compose the endpoints above into bigger jobs. Everything runs **server-side** in the app
pod (closing the tab doesn't stop a run) and streams a trace to the browser: every LLM turn, tool call, GPU job,
second and cent.

- **Pipelines** (`/pipelines`): a recipe of steps whose dependencies form a DAG. A step starts as soon as the
  steps it reads are done, so independent branches run in parallel, and a *fan-out* step turns a list into one
  GPU job per item. Templates: **Product launch kit** (LLM writes 4 shot ideas → FLUX renders them in parallel →
  an LLM picks the hero shot, looking at the images when it can → Wan animates it *while* the launch copy is
  written), **Style explorer** and **Storyboard**. Steps are editable in the UI or as JSON; a live graph shows
  each step's state, time and cost.
- **Agent** (`/agent`): an LLM gets a brief, a budget and seven tools (`generate_images` in parallel at draft or
  final quality, `animate_image`, `view_image` for models that can see, `search_library`, `check_endpoints`,
  `estimate_cost`, `finish`). The app enforces the budget (dollars for GPU + tokens, images, clips, turns): a call
  that would exceed it comes back as a tool error, and the agent has to adapt. Personas (balanced, frugal,
  perfectionist) change behaviour on the same model.
- **Battleground** (`/battle`): two agents, the same brief and budget, at the same time. A Claude judge
  scores both deliveries (it sees the images, plus what each agent spent); a person can overrule it. Results feed
  an Elo leaderboard per model + persona.

**Which LLM.** Agents can run on **Claude** (Opus 5.5, Sonnet 5.5, Haiku 5.5, via the Anthropic SDK; the strongest
tool use, and vision) or on **Qwen3-8B on a Runpod Serverless vLLM endpoint** (`gdk2e7i6wa5zto`, Runpod's
`worker-v1-vllm` image, OpenAI-compatible route with tool calling, 24 GB GPUs, scale to zero,
[`scripts/deploy_llm.sh`](scripts/deploy_llm.sh)). That puts three kinds of Runpod workload in one demo: image
generation, video generation and LLM inference. A scripted no-LLM baseline is always available, so the whole
flow works without any key, and a **dry run** replaces GPU jobs with placeholders priced at the measured costs.

**Measured** (4 Nov 2026, real endpoints, single runs):

| Run | Result |
|---|---|
| Qwen3-8B tool call (direct) | correct `generate_images` call with both prompts; **1.3 s** GPU time warm, **211 s** first request (model placement + cold start) |
| Agent, Qwen3-8B, *frugal* persona, one-image brief | searched the library first, rendered **1 draft image**, finished in 3 turns (172 s wall, including the LLM cold start): **$0.0035 GPU** + $0.027 LLM (estimate: GPU-seconds, mostly the LLM cold start) |
| Pipeline *Product launch kit*, Qwen3-8B | all 5 steps done: 4 FLUX images in parallel (**$0.038**, 155 s including a FLUX cold start), hero picked from the prompts (Qwen can't see images), copy written while Wan animated the hero (2 s clip, **$0.038**). Total **$0.076 GPU** + $0.028 LLM (estimate); 12 min wall, most of it the clip waiting for a throttled Wan host |

Claude-driven runs and judged battles need the deployment's access code and are run from the hosted app; their
numbers aren't claimed here yet. Costs are labelled honestly in the UI: Claude tokens are metered at list price,
vLLM time is an estimate (GPU-seconds × the pool's price).

## Fine-tuning: FLUX LoRAs

The **Fine-tune** page (`/lora`) teaches FLUX.1-dev a style, product or character from the library: pick 4–40
images, name a trigger word, and a LoRA trains on a Runpod Serverless GPU. Then "Use in Studio" puts it in the
prompt box with a strength slider.

- **Same worker image, separate endpoint.** `workers/image` handles `task: "train_lora"`
  ([`lora_train.py`](workers/image/lora_train.py)) next to generation. Training runs on its own endpoint
  (`eu4cak6ivq2uep`, [`scripts/deploy_train.sh`](scripts/deploy_train.sh): max 1 worker, 1 h job timeout, 15 s idle)
  so a 10-minute training never holds a worker the Studio is waiting for.
- **Data path without a bucket.** The job gets URLs to the library images on the app; each caption is the trigger
  word plus the image's original prompt. The worker `PUT`s the finished adapter (safetensors) back to the app with a
  one-time token (only its SHA-256 is stored). An image job that names a LoRA gets its URL; the worker downloads and
  caches it and keeps one adapter loaded at a time.
- **Training recipe.** Rank 16 on the attention projections (`to_q/k/v/out`), flow-matching loss with FLUX's
  resolution-shifted logit-normal timesteps, guidance 1.0, bf16 with gradient checkpointing, 512 px, AdamW 1e-4;
  text and image latents are encoded once and the encoders moved off the GPU. Presets: 400 / 800 / 1500 steps.
- **Guardrails.** One training at a time, 3 per day, the access code; the progress bar shows Runpod's own status
  (waiting for a GPU → starting → step / loss), so a queued job never reads as running.

**Measured** (4 Nov 2026, one run, 6 Europa images from the library, Standard = 800 steps, rank 16, 512 px):

| Training | Value |
|---|---|
| GPU | RTX 6000 Ada (48 GB) |
| Queue (`delayTime`, first worker pulling the 30 GB image) | 299 s |
| Training, 800 steps | **641 s** (0.80 s/step); image download 8.8 s, encoding 6.9 s, upload 3.3 s |
| GPU time (`executionTime`) · **cost** | 665 s · **$0.32** |
| Adapter | 37.4 MB safetensors · final loss 0.341 |
| Generating with it (1024², 28 steps) | 19.8 s inference vs 15.9 s without on the same GPU (+25%, one pair; the adapter isn't fused) |
| From the live Studio ("Use in Studio") | 17.0 s GPU time, **$0.0083** on an L40S; the worker's response echoes the LoRA id and strength |

<table><tr>
<td><img src="docs/examples/lora-off.jpg" width="300" alt="Lighthouse at night without the LoRA"></td>
<td><img src="docs/examples/lora-europa.jpg" width="300" alt="Same prompt and seed with the Europa LoRA"></td>
</tr></table>

*"zxq_europa, a lighthouse on a rocky coast at night", seed 4242: without the LoRA (left) and with the Europa LoRA
at strength 1.0 (right). The LoRA moves it to the training set's cold, glowing blue look; with 6 images and a
subject that isn't in the set, the shift is clear but moderate.*

**Two platform notes from shipping it.** The account's worker quota (5 max workers summed over all endpoints) was
full, so the image endpoint went from max 2 to max 1 to make room. And with a single max worker, the training
endpoint's only worker was *throttled* (no free GPU on its host) for ~39 min before two test images ran; nothing
bills while queued, but a production setup would allow more GPU pools or a second worker.

## Architecture

```mermaid
flowchart LR
    B[Browser] -->|access code| A["Next.js app<br/>Runpod CPU pod"]
    A -->|"/run · /status · /health<br/>key from Runpod Secrets"| Q[[Serverless queue<br/>autoscaler]]
    C[curl · Postman · bench.py] -->|"/runsync · /run"| Q
    Q --> W["GPU workers: handler.py + FLUX.1-dev BF16<br/>48 GB: L40 · L40S · 6000 Ada · A40 · A6000"]
    A --- V[("Network volume<br/>history + image/video library")]
    R[(Private Docker Hub<br/>30.6 GB image)] -.->|pull per new host| W
    A -->|"Animate: /run · /status"| VQ[[Video endpoint queues]]
    VQ --> VW["GPU workers: Wan 2.2 (48 GB) · LTX-2.5 (80 GB)<br/>image → video"]
    MC[(Runpod model cache<br/>Wan 2.2 · LTX-2.5)] -.->|mounted on host| VW
    A -->|"agents: OpenAI route + tools"| LQ[[vLLM endpoint<br/>Qwen3-8B, 24 GB]]
    A -->|"agents + judge"| AN[Anthropic API<br/>Claude]
```
Request flow, image layers and the full diagram: [`docs/architecture.md`](docs/architecture.md).

## Design decisions

**1. Serverless, not a Pod.** Creative traffic is bursty: a seller makes 20 images in ten minutes, then nothing
for hours. Serverless bills per second of worker time and scales to zero, so idle costs nothing; a Pod
bills around the clock. The trade-off is the cold start, measured above and handled in decisions 4–5.

**2. A 48 GB GPU pool, with one type excluded.** BF16 FLUX.1-dev peaks at 33.8 GB, so 48 GB cards run it
without CPU offloading. 80 GB cards would cost 1.6–3× more per hour for no benefit. The endpoint uses two pools,
`ADA_48_PRO` (L40, L40S, RTX 6000 Ada at $1.75/h) and `AMPERE_48` (A40, A6000 at $1.22/h), because L40S supply was
low and a single type left jobs queued. Lesson learned: asking for "NVIDIA L40S" selects the whole
`ADA_48_PRO` pool, which also contains an **RTX PRO 6000 Blackwell MIG slice** (sm_120). The image's PyTorch
build (CUDA 12.6) has no sm_120 kernels, so those workers failed the SDK's GPU fitness check and exited. The fix
is `gpu.excludedTypes` via the REST v2 API (runpodctl can't set it), now part of `deploy.sh`. Excluding a type
doesn't evict workers already placed; the endpoint had to be recreated.

**3. Weights baked into the image.** The brief asks for "the handler and the model" in the image, and it gives
the most predictable runtime: no Hugging Face call or token on workers (`HF_HUB_OFFLINE=1`), and the model loads
in **8.1 s** from local disk. The cost is a 30.6 GB image that each new host pulls once: **~7–10+ min**
measured. Alternatives:
- **Network volume:** small image, $0.07/GB/month, but it pins the endpoint to one data center (fewer GPUs),
  and Runpod's docs say weights load slower from a volume than from its model cache (not measured here).
- **Runpod model caching** (`--model-reference`): Runpod pre-places weights on hosts and doesn't bill the
  download. The obvious next experiment, see next steps.

Layer order (deps → weights → code) means a handler change pushes a few KB; v0.1.0 → v0.2.0 took 5 s.

**4. Workers: min 0, max 2 (now 1), idle timeout 60 s, FlashBoot on.** Min 0 means no idle spend for a demo. 60 s keeps
a worker warm across a user's burst of edits (0.1 s queue instead of 35–93 s). Max 2 let the autoscaler run
jobs in parallel (the app's bulk mode shows the speed-up) and capped the worst-case spend at about $3.50/h. The
account's quota is 5 workers across all endpoints, so I later lowered it to 1 to free a slot for the LoRA
training endpoint; bulk jobs now queue one after another. For a
production interactive path I'd run **1 active worker** (always on; Runpod's pricing page offers discounts for
active workers on request) so the first request
of the day never sees a cold start, and keep the flex workers for bursts.

**5. `/run` + polling in the app, `/runsync` for scripts.** Async jobs survive multi-minute cold starts, show step
progress and keep results for ~30 min. `/runsync` (results kept ~1 min) is the simplest call for curl.

**6. Base64 by default, URLs when it matters.** A 1024² PNG is ~1.34 MB of base64 per image, fine for one image
per call. The handler can upload to S3-compatible storage (`output: "url"`) to keep payloads small for batches
and video; the app requests JPEG.

**7. Licensing.** FLUX.1-dev is **non-commercial**. For a paid product, switch to FLUX.1-schnell or another
Apache-2.0 model. The handler only needs a new `MODEL_ID`, and the brief's worked example is kept here. LTX-2.5,
planned for video, is free for commercial use under $10M annual revenue (LTX-2.x Community License).

**8. Secrets never in code, images or logs.** The HF token is a BuildKit secret and never lands in a layer. The
Runpod key and access code are Runpod Secrets on the app pod. The browser never sees the key; `.env` is gitignored.

**9. FP8.** The handler has an FP8 path (torchao `Float8WeightOnlyConfig`), but it is **not measured yet**, so no
claims here.

**10. Two endpoints, not one.** Image and video differ in GPU class (48 GB vs 80 GB), job length (seconds vs
minutes) and price per hour. Separate endpoints scale independently, so a burst of video jobs can't queue image
requests behind them, and each pays only for the GPU it needs. The app also keeps separate job stores and daily
caps for the two.

**11. Model caching for the video weights.** Baking worked well for FLUX (30.6 GB, 8.1 s model load) because the
brief asked for it and the image is pullable in minutes. At 72 GB, baking would make every new host pull ~80 GB
before its first job. Runpod model caching keeps the image at 8 GB and moves the weight download off the billed
path. The trade-off: the first placement on a host is slow and opaque (no progress API), and the endpoint has to
be created where Runpod can hold a token for the gated repo.

**12. The app runs the agent loop, not the model provider.** Agents call the app's own functions (the same code
paths, limits and library as the Studio), so the app can enforce budgets per call, count agent jobs against the
demo's daily caps, and show one trace whichever LLM is driving. Each provider adapter keeps its own native,
append-only history (Anthropic messages for Claude, OpenAI messages for vLLM) rather than translating one
format into the other.

**13. An open model on Runpod next to Claude.** Claude is the stronger agent and can look at images, but the
battleground's point is the comparison: Qwen3-8B on a 24 GB serverless GPU costs fractions of a cent per turn
once warm, and scales to zero. Seeing both on the same brief, budget and endpoints, scored side by side, is
the useful result.

## Platform notes

Things found while deploying, worth knowing for anyone building on Runpod (all hit and fixed in this repo):

- **A GPU type is a pool.** `--gpu-id "NVIDIA L40S"` became pool `ADA_48_PRO`, which includes an RTX PRO 6000
  Blackwell MIG slice. Exclude incompatible types with REST v2 `gpu.excludedTypes` (`pools` and `excludedTypes`
  are replaced together). Exclusions don't evict workers already placed: they crash-looped and held the only
  worker slot until the endpoint was recreated.
- **Template changes don't replace warm workers.** After moving the template to v0.2.0, the next 21 jobs still
  ran on the warm v0.1.0 worker.
- **Status signals while a host pulls the image are misleading.** The v1 worker list showed pulling workers as
  `EXITED` and `/health` counted them `idle`/`ready`; only the worker logs told the truth. Runpod's `idle`
  workers are stopped and cached for a fast resume and are **not billed** (verified against `currentSpendPerHr`).
- **Cached models mount at `/runpod/model-store/huggingface/<org>/<name>/<revision>`** (from
  `runpodctl serverless model-status`), not the `/runpod-volume/huggingface-cache/hub` layout in the docs. The
  video handler checks both and logs what it finds.
- **A gated model reference is validated at endpoint creation.** `runpodctl serverless create --model-reference`
  fails without a token Runpod can use; the console's *Cached model* field takes a Runpod Secret.
- **Runpod's HTTP proxy is behind Cloudflare.** Next.js marks prerendered pages `s-maxage=31536000`, and
  Cloudflare served the old HTML after a deploy. The app now sends `max-age=0, must-revalidate` on pages; the
  already-cached URL could only be escaped with a new pod.
- **CPU pods don't get a pod volume** (`volumeInGb` was ignored); the app's history and library use a network
  volume instead.
- **FlashBoot can resume a worker on the old image.** After a template moved to a fixed image (v0.2.1), two jobs
  still ran on a FlashBoot-resumed v0.2.0 worker. What worked: FlashBoot off, max workers 0 until `/health`
  showed no workers, then max 1 and FlashBoot back on. The REST v2 value is `"flashboot": "FLASHBOOT"`
  (`OFF | FLASHBOOT | PRIORITY_FLASHBOOT`), not `"ON"`.
- **Right after un-pausing**, `/run` returns `409 ENDPOINT_PAUSED` for a few seconds; retry.
- **Restricted API keys list endpoints explicitly.** The app's key (a Runpod Secret) was scoped to the endpoints
  that existed when it was made, so a new endpoint answered `403 Forbidden` until the key's permissions were
  extended. The app now names that cause in the error.
- **Pods read Secrets at container start.** After the key's value changed, the app kept the old one through a
  plain restart; re-applying the pod's settings (same image and env, REST `PATCH /pods/{id}`) rebuilt the
  container and picked it up.
- **Long cold starts outlast synchronous HTTP.** The vLLM worker's OpenAI route holds the request through a cold
  start. One pipeline step failed with `fetch failed` at exactly 300 s, which is Node's default wait for response headers,
  while the worker was still loading. The app now sends LLM calls through the queue (`/run` with
  `openai_route`, then `/status`), which survives any queue time and cancels the job if no worker answers in
  10 minutes. A measured cold call: 170 s in the queue, 0.7 s of execution.
- **Structured outputs reject numeric bounds.** The battle judge's verdict schema had `minimum`/`maximum` on its
  1-10 scores; the Claude API answers that with a 400 (the SDK strips them only in `.parse()`), so the first live
  battle got no verdict. The unit test hadn't caught it because the SDK is mocked there. The bounds now live in the
  field description and are enforced after parsing, a test asserts the schema has no unsupported keywords, and a
  failed battle can be judged again from the page.
- **Throttled workers.** A worker whose host has the model cached but whose GPU is busy with other customers shows
  as `throttled`; jobs wait in the queue until it frees up or another host is used.
- **Silent dependencies.** Wan's pipeline imports `ftfy` only when it runs; the first job failed with
  `NameError`. The Dockerfile's `check` stage now imports it, so CI catches it.

## Cost and business case

**Use case:** small e-commerce sellers who need on-brand product images (and, next, 5-second social clips)
without a photo shoot.

Measured unit cost: **$0.0107 per 1024² image** of GPU execution. On top of that, each burst of activity
pays for the warm worker's idle timeout (60 s × $1.75/h ≈ $0.03) and, if cold, the model load.

| Plan: $29/month, 300 images | |
|---|---|
| GPU execution, 300 × $0.0107 | $3.21 |
| Idle timeouts, if spread over 60 sessions (estimate) | $1.75 |
| **GPU cost per subscriber** | **≈ $5**, so **~83% gross margin** before app hosting (~$0.06/h CPU pod) |

The honest risk: generation itself is a commodity. Per-image and per-second video APIs keep getting cheaper, so
the value is in what a platform like this makes easy: brand LoRAs trained on a seller's products, bundling
image + clip + copy, and data control. For Runpod, this is recurring GPU spend that follows the customer's
growth: 10,000 images a month is about **61 GPU-hours** at the measured 21.9 s per image (video multiplies that).

## Limitations and next steps
- **Video benchmark:** one clip per model so far; next, a small benchmark (540p/720p, 2 s/5 s, warm vs cold) for
  time and $/clip.
- **Fine-tuning:** a held-out evaluation (CLIP/style similarity to the training set vs the base model) across
  steps and ranks, fusing the adapter to remove the +25% inference cost, and captions written by a vision LLM
  instead of the original prompts.
- **Agents:** a fixed set of battle briefs run several times per contestant, so the leaderboard means something
  statistically; Qwen3 with thinking on versus off; and an active LLM worker during demos to remove its cold start.
- **Cold-start study:** the FLUX handler with Runpod model caching instead of baked weights; compare first-request
  times on fresh hosts against the 690 s / 93 s / 35 s measured here (the video endpoint is the first data point
  for caching).
- **Blackwell-capable image:** a CUDA 12.8+ PyTorch build so the full GPU pool is usable, and a Dockerfile where
  the weights stage doesn't depend on the deps stage (today a dependency bump re-pushes 34 GB).
- **FP8 and step caching:** measure speed, quality and $/image against BF16.
- **Autoscaling policy:** load-test bursts (20–40 jobs) to tune max workers and the queue-delay threshold.
- **Production hardening:** a safety filter on prompts/images, structured metrics (queue time, cold-start rate,
  $/image per customer), alerts on `unhealthy` workers, S3 storage for the library instead of a pod volume.
- **Known demo limits:** the app's daily cap and rate limit are per pod instance; a job in flight while the app
  pod restarts is lost from the app's view (it still completes on Runpod).

## Repository
```
workers/image/     FLUX.1-dev Serverless worker: handler.py, lora_train.py (LoRA training), Dockerfile (deps → check → weights → final)
workers/video/     Wan 2.2 / LTX-2.5 image-to-video worker: handler.py, Dockerfile (weights via model caching)
tests/             image + video handler tests with mocked pipelines, benchmark report tests (run in CI)
app/tests/         Vitest: limits, library, pipelines, tools + budgets, agent loop, Claude/vLLM adapters,
                   battles + Elo, every API route against a fake Runpod API (run in CI)
bench/             bench.py (Runpod delayTime/executionTime, cost), prices.yaml, raw results
app/               Next.js 16 app: Studio, bulk, library, Animate, dashboards, Pipelines, Agent, Battleground, Fine-tune
scripts/           build_and_push.sh, deploy.sh (image endpoint), deploy_video.sh, deploy_video_wan.sh,
                   deploy_llm.sh (vLLM agent endpoint), deploy_train.sh (LoRA training endpoint), deploy_app.sh (app pod),
                   generate.sh, curl examples
postman/           Postman collection: image runsync/run/status/errors/health, video run/status/errors/health
docs/              architecture, benchmarks, example requests/responses, screenshots
.github/workflows  CI: ruff, pytest, hadolint + check-stage builds of both worker images, app lint/typecheck/test/build
```
