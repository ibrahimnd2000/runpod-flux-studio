#!/usr/bin/env bash
# Create the Serverless template and endpoint for the FLUX.1-dev worker with runpodctl.
#
#   export REGISTRY_AUTH_ID=...    # runpodctl registry list
#   export RUNPOD_API_KEY=...      # or: set -a; source .env; set +a
#   scripts/deploy.sh
#
# Creating the template and endpoint is free; with WORKERS_MIN=0 nothing bills
# until the first request wakes a worker.
set -euo pipefail

IMAGE="${IMAGE:-docker.io/ibrahimnd2000/flux-worker:v0.3.1}"
: "${REGISTRY_AUTH_ID:?set REGISTRY_AUTH_ID (runpodctl registry list)}"
: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (needed to set GPU exclusions)}"

# 48 GB: BF16 FLUX.1-dev fits without CPU offloading. Runpod resolves "NVIDIA L40S"
# to its serverless pool ADA_48_PRO, which also contains an RTX PRO 6000 Blackwell
# MIG slice (sm_120). The image's torch (cu126) has no sm_120 kernels, so that type
# is excluded below. AMPERE_48 (A40 / RTX A6000, sm_86, cheaper per hour) is added
# as a second pool because L40S supply is often low; Runpod places workers on
# whichever listed pool has capacity.
GPU_ID="${GPU_ID:-NVIDIA L40S}"
WORKERS_MIN="${WORKERS_MIN:-0}"     # scale to zero for the demo
WORKERS_MAX="${WORKERS_MAX:-1}"     # 2 lets another host take a job a throttled worker holds, but the account quota is 5 across endpoints
IDLE_TIMEOUT="${IDLE_TIMEOUT:-60}"  # seconds a warm worker waits for the next job (billed)
EXEC_TIMEOUT="${EXEC_TIMEOUT:-600}" # max seconds per job

# Container disk holds the unpacked image (~41 GB) plus scratch space (LoRA cache, outputs).
# Set TEMPLATE_ID to reuse an existing template instead of creating one.
if [[ -z "${TEMPLATE_ID:-}" ]]; then
  TEMPLATE_ID=$(runpodctl template create \
    --name "flux-worker-${IMAGE##*:}" \
    --image "${IMAGE}" \
    --serverless \
    --registry-auth-id "${REGISTRY_AUTH_ID}" \
    --container-disk-in-gb 60 \
    --env '{"MODEL_PRECISION":"bf16"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "template: ${TEMPLATE_ID}"

ENDPOINT_ID=$(runpodctl serverless create \
  --name flux-dev-image \
  --template-id "${TEMPLATE_ID}" \
  --gpu-id "${GPU_ID}" \
  --workers-min "${WORKERS_MIN}" \
  --workers-max "${WORKERS_MAX}" \
  --idle-timeout "${IDLE_TIMEOUT}" \
  --execution-timeout "${EXEC_TIMEOUT}" \
  --min-cuda-version 12.6 \
  --flash-boot \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "endpoint: ${ENDPOINT_ID}"

# runpodctl can't set exclusions; REST v2 PATCH replaces pools + excludedTypes together.
curl -sS -X PATCH "https://api.runpod.io/v2/serverless/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"gpu":{"pools":["ADA_48_PRO","AMPERE_48"],"excludedTypes":["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"]}}' \
  | python3 -c 'import json,sys; g=json.load(sys.stdin)["gpu"]; print("gpu pools:", g["pools"], "excluded:", g.get("excludedTypes"))'
