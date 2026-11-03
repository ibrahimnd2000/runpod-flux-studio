# Runpod FLUX Studio

> _TODO: one-paragraph summary: what this is, what it demonstrates, headline numbers (cold start, warm latency, $/image)._

**Status:** image worker implemented and tested locally (mock pipeline). Docker image, deployment and benchmarks are in progress.

## Contents
1. [Architecture](#architecture)
2. [Quick start](#quick-start)
3. [API](#api)
4. [Results](#results)
5. [Design decisions](#design-decisions)
6. [Cost and business case](#cost-and-business-case)
7. [Limitations and next steps](#limitations-and-next-steps)

## Architecture
_TODO: mermaid diagram (see docs/architecture.md)._

## Quick start

### Run the image worker locally (no GPU)
```bash
python3 -m venv .venv && .venv/bin/pip install -r workers/image/requirements-dev.txt
cd workers/image

# Unit tests
../../.venv/bin/pytest -q tests

# Runpod SDK local test mode: runs one job from test_input.json and exits
MOCK_PIPELINE=1 ../../.venv/bin/python handler.py

# Local HTTP server that mimics the endpoint API (/run, /runsync, /status)
MOCK_PIPELINE=1 ../../.venv/bin/python handler.py --rp_serve_api --rp_api_port 8000
curl -s -X POST localhost:8000/runsync -H 'Content-Type: application/json' \
  -d '{"input":{"prompt":"a ceramic mug","width":512,"height":512,"seed":42}}'
```
`MOCK_PIPELINE=1` replaces FLUX with a deterministic gradient generator, so validation, error handling and the response shape can be tested on a laptop.

### Call the deployed endpoint
_TODO: curl + Postman against `https://api.runpod.ai/v2/<ENDPOINT_ID>/runsync`._

## API

### Input (`job.input`)
| Field | Type | Default | Rules |
|---|---|---|---|
| `prompt` | string | required | non-empty, ≤ 1,000 chars |
| `width`, `height` | int | 1024 | clamped to 256–1536, rounded to a multiple of 16 |
| `num_inference_steps` | int | 28 | clamped to 1–50 |
| `guidance_scale` | float | 3.5 | clamped to 0–20 |
| `seed` | int | random | 0 – 2³²−1; the seed used is always returned |
| `num_images` | int | 1 | clamped to 1–4 |
| `output` | `"base64"` \| `"url"` | `"base64"` | `url` needs bucket env vars on the endpoint |
| `image_format` | `"png"` \| `"jpeg"` | `"png"` | JPEG (quality 92) gives a much smaller payload; size to be measured |

Values outside a range are clamped, not rejected, and each adjustment is listed in `notes`. Unknown fields, wrong types and an empty prompt return `{"error": "..."}`, which Runpod reports as `status: FAILED`.

`negative_prompt` is rejected on purpose. FLUX.1-dev is guidance-distilled: `guidance_scale` is an input to the model, not classifier-free guidance, so there is no negative branch for the prompt to steer.

### Output
```json
{
  "images": ["<base64 PNG>"],
  "seed": 42,
  "timings": { "inference_ms": 0.0, "total_ms": 0.0 },
  "params": { "width": 1024, "height": 1024, "num_inference_steps": 28, "...": "..." }
}
```

## Results
_TODO: benchmark table (cold vs warm, GPU types), example images._

## Design decisions
_TODO: Serverless vs Pods · GPU per endpoint · two endpoints · baked weights vs network volume · worker settings · URLs vs base64 · licensing · FP8._

## Cost and business case
_TODO: built from measured numbers in bench/._

## Limitations and next steps
_TODO._

## Repository layout
```
workers/image/   FLUX.1-dev Serverless worker (handler, Dockerfile, tests)
workers/video/   Wan 2.2 TI2V-5B worker (stretch)
app/             Next.js web app (API key stays server-side)
bench/           benchmark + cost scripts, prices.yaml
scripts/         build/push, deploy notes, curl examples
postman/         Postman collection
docs/            architecture and raw benchmark results
```
