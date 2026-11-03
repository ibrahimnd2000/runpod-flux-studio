#!/usr/bin/env bash
# Create the Serverless template and endpoint for the LTX-2.5 video worker.
#
#   export RUNPOD_API_KEY=...        # or: set -a; source .env; set +a
#   scripts/deploy_video.sh
#
# Weights come from Runpod model caching (--model-reference). The repo is gated:
# after this script, open the endpoint in the Runpod console (Manage -> Edit
# Endpoint -> Model) and add a Hugging Face token from an account that accepted
# the LTX-2.5 licence. That's the only documented way to give the cache a token.
#
# Separate from the image endpoint on purpose: different GPU class (80 GB) and
# independent scaling, so long video jobs can't starve image requests.
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (needed to set the GPU pools)}"
IMAGE="${IMAGE:-docker.io/ibrahimnd2000/ltx-video-worker:v0.1.1}"
MODEL_REF="${MODEL_REF:-https://huggingface.co/Lightricks/LTX-2.5-Diffusers:main}"
WORKERS_MAX="${WORKERS_MAX:-1}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-60}"
EXEC_TIMEOUT="${EXEC_TIMEOUT:-1800}" # a 10 s 720p clip can take minutes

if [[ -z "${TEMPLATE_ID:-}" ]]; then
  TEMPLATE_ID=$(runpodctl template create \
    --name "ltx-video-worker-${IMAGE##*:}" \
    --image "${IMAGE}" \
    --serverless \
    --container-disk-in-gb 30 \
    --env '{"OFFLOAD":"model","MAX_RESULT_MB":"15"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "template: ${TEMPLATE_ID}"

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
echo "endpoint: ${ENDPOINT_ID}"

# A100 (AMPERE_80, $2.72/h) and H100 (ADA_80_PRO, $5.39/h): both run the cu126
# image (sm_80 / sm_90); two pools improve availability.
curl -sS -X PATCH "https://api.runpod.io/v2/serverless/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"gpu":{"pools":["AMPERE_80","ADA_80_PRO"],"excludedTypes":[]}}' \
  | python3 -c 'import json,sys; g=json.load(sys.stdin)["gpu"]; print("gpu pools:", g["pools"])'
