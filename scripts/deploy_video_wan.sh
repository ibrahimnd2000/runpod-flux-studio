#!/usr/bin/env bash
# Template + endpoint for the video worker running Wan 2.2 TI2V-5B (VIDEO_MODEL=wan22).
#
#   export RUNPOD_API_KEY=...        # or: set -a; source .env; set +a
#   scripts/deploy_video_wan.sh
#
# Same image as the LTX-2.5 endpoint, different model family. Wan isn't gated, so
# unlike LTX-2.5 the cached-model endpoint can be created entirely from the CLI.
# 48 GB pools: Wan fits, and these GPUs are far easier to get than 80 GB ones.
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (needed to set GPU exclusions)}"
IMAGE="${IMAGE:-docker.io/ibrahimnd2000/ltx-video-worker:v0.2.0}"
MODEL_REF="${MODEL_REF:-https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers:main}"

if [[ -z "${TEMPLATE_ID:-}" ]]; then
  TEMPLATE_ID=$(runpodctl template create \
    --name "wan-video-worker-${IMAGE##*:}" \
    --image "${IMAGE}" \
    --serverless \
    --container-disk-in-gb 30 \
    --env '{"VIDEO_MODEL":"wan22","MAX_RESULT_MB":"15"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "template: ${TEMPLATE_ID}"

ENDPOINT_ID=$(runpodctl serverless create \
  --name wan-video \
  --template-id "${TEMPLATE_ID}" \
  --gpu-id "NVIDIA L40S" \
  --model-reference "${MODEL_REF}" \
  --workers-min 0 \
  --workers-max 1 \
  --idle-timeout 60 \
  --execution-timeout 1800 \
  --min-cuda-version 12.6 \
  --flash-boot \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "endpoint: ${ENDPOINT_ID}"

# Same 48 GB pools as the image endpoint, minus the Blackwell MIG slice the cu126
# image can't run on (see deploy.sh).
curl -sS -X PATCH "https://api.runpod.io/v2/serverless/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"gpu":{"pools":["ADA_48_PRO","AMPERE_48"],"excludedTypes":["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"],"minCudaVersion":"12.6"}}' \
  | python3 -c 'import json,sys; g=json.load(sys.stdin)["gpu"]; print("gpu pools:", g["pools"], "excluded:", g.get("excludedTypes"))'
