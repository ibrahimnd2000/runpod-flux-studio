#!/usr/bin/env bash
# Template + endpoint setup for the LTX-2.5 video worker (Runpod model caching).
#
# LTX-2.5 is a gated Hugging Face repo, and Runpod validates the model reference
# when the endpoint is created, so `runpodctl serverless create --model-reference`
# fails unless Runpod already holds a token. What worked (3 Nov 2026):
#   1. scripts/deploy_video.sh                  -> creates the template, prints its id
#   2. Runpod console -> Serverless -> New endpoint -> "Use an existing template";
#      Cached model = Lightricks/LTX-2.5-Diffusers; Hugging Face access token =
#      a Runpod Secret ({{ RUNPOD_SECRET_hf_token_ltx }}); 80 GB; max workers 1;
#      idle 60 s; execution timeout 1800 s; FlashBoot on.
#   3. ENDPOINT_ID=<new id> scripts/deploy_video.sh  -> adds the A100 + H100 pools and
#      the CUDA 12.6 floor (the console offered only the H100 group, CUDA >= 12.0).
# For a public model, CREATE_ENDPOINT=1 does step 2 from the CLI instead.
#
#   export RUNPOD_API_KEY=...        # or: set -a; source .env; set +a
#
# Separate from the image endpoint on purpose: different GPU class (80 GB) and
# independent scaling, so long video jobs can't starve image requests. The worker
# finds the cached weights under /runpod/model-store/huggingface (see handler.py).
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (needed to set the GPU pools)}"
IMAGE="${IMAGE:-docker.io/ibrahimnd2000/ltx-video-worker:v0.1.1}"
MODEL_REF="${MODEL_REF:-https://huggingface.co/Lightricks/LTX-2.5-Diffusers:main}"
WORKERS_MAX="${WORKERS_MAX:-1}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-60}"
EXEC_TIMEOUT="${EXEC_TIMEOUT:-1800}" # a 10 s 720p clip can take minutes

if [[ -z "${TEMPLATE_ID:-}" && -z "${ENDPOINT_ID:-}" ]]; then
  TEMPLATE_ID=$(runpodctl template create \
    --name "ltx-video-worker-${IMAGE##*:}" \
    --image "${IMAGE}" \
    --serverless \
    --container-disk-in-gb 30 \
    --env '{"OFFLOAD":"model","MAX_RESULT_MB":"15"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "template: ${TEMPLATE_ID:-(existing endpoint ${ENDPOINT_ID:-})}"

if [[ -z "${ENDPOINT_ID:-}" ]]; then
  if [[ "${CREATE_ENDPOINT:-0}" != "1" ]]; then
    echo "Next: create the endpoint in the console from this template (see the header), then run"
    echo "  ENDPOINT_ID=<id> $0"
    exit 0
  fi
  # 80 GB: the 22B transformer (BF16) plus the Gemma 4 text encoder.
  ENDPOINT_ID=$(runpodctl serverless create \
    --name ltx-video \
    --template-id "${TEMPLATE_ID}" \
    --gpu-id "NVIDIA A100 80GB PCIe" \
    --model-reference "${MODEL_REF}" \
    --workers-min 0 \
    --workers-max "${WORKERS_MAX}" \
    --idle-timeout "${IDLE_TIMEOUT}" \
    --execution-timeout "${EXEC_TIMEOUT}" \
    --min-cuda-version 12.6 \
    --flash-boot \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "endpoint: ${ENDPOINT_ID}"

# A100 (AMPERE_80, $2.72/h), H100 (ADA_80_PRO, $5.39/h) and H200 (HOPPER_141, $6.99/h)
# all run the cu126
# image (sm_80 / sm_90); 80 GB supply is often low, so more pools = shorter queues.
curl -sS -X PATCH "https://api.runpod.io/v2/serverless/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"gpu":{"pools":["AMPERE_80","ADA_80_PRO","HOPPER_141"],"excludedTypes":[],"minCudaVersion":"12.6"}}' \
  | python3 -c 'import json,sys; g=json.load(sys.stdin)["gpu"]; print("gpu pools:", g["pools"])'
