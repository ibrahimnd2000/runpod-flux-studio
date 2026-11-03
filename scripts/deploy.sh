#!/usr/bin/env bash
# Create the Serverless template and endpoint for the FLUX.1-dev worker with runpodctl.
#
#   export REGISTRY_AUTH_ID=...    # runpodctl registry list
#   scripts/deploy.sh
#
# Creating the template and endpoint is free; with WORKERS_MIN=0 nothing bills
# until the first request wakes a worker.
set -euo pipefail

IMAGE="${IMAGE:-docker.io/ibrahimnd2000/flux-worker:v0.1.0}"
: "${REGISTRY_AUTH_ID:?set REGISTRY_AUTH_ID (runpodctl registry list)}"

# 48 GB: BF16 FLUX.1-dev fits without CPU offloading. Runpod resolves "NVIDIA L40S"
# to its serverless pool ADA_48_PRO (L40 / L40S / RTX 6000 Ada), so workers can land
# on any of those at the same price.
GPU_ID="${GPU_ID:-NVIDIA L40S}"
WORKERS_MIN="${WORKERS_MIN:-0}"     # scale to zero for the demo
WORKERS_MAX="${WORKERS_MAX:-1}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-60}"  # seconds a warm worker waits for the next job (billed)
EXEC_TIMEOUT="${EXEC_TIMEOUT:-600}" # max seconds per job

# Container disk holds the cached image (~38 GB) plus scratch space.
TEMPLATE_ID=$(runpodctl template create \
  --name "flux-worker-${IMAGE##*:}" \
  --image "${IMAGE}" \
  --serverless \
  --registry-auth-id "${REGISTRY_AUTH_ID}" \
  --container-disk-in-gb 60 \
  --env '{"MODEL_PRECISION":"bf16"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "template: ${TEMPLATE_ID}"

runpodctl serverless create \
  --name flux-dev-image \
  --template-id "${TEMPLATE_ID}" \
  --gpu-id "${GPU_ID}" \
  --workers-min "${WORKERS_MIN}" \
  --workers-max "${WORKERS_MAX}" \
  --idle-timeout "${IDLE_TIMEOUT}" \
  --execution-timeout "${EXEC_TIMEOUT}" \
  --min-cuda-version 12.6 \
  --flash-boot
