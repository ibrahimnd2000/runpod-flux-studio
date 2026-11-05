#!/usr/bin/env bash
# Create the Serverless template and endpoint that trains FLUX.1-dev LoRAs.
#
#   export REGISTRY_AUTH_ID=...    # runpodctl registry list (the image is private)
#   export RUNPOD_API_KEY=...      # or: set -a; source .env; set +a
#   scripts/deploy_train.sh
#
# Same image as the image endpoint (workers/image: jobs with task "train_lora"),
# different settings: one worker at most (a training holds its GPU for 10-30 min),
# a 1-hour job timeout and a short idle timeout. Creating it is free; with
# min workers 0 nothing bills until a training job arrives.
set -euo pipefail

IMAGE="${IMAGE:-docker.io/ibrahimnd2000/flux-worker:v0.3.1}"
: "${REGISTRY_AUTH_ID:?set REGISTRY_AUTH_ID (runpodctl registry list)}"
: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (needed to set GPU pools)}"

if [[ -z "${TEMPLATE_ID:-}" ]]; then
  TEMPLATE_ID=$(runpodctl template create \
    --name "flux-lora-train-${IMAGE##*:}" \
    --image "${IMAGE}" \
    --serverless \
    --registry-auth-id "${REGISTRY_AUTH_ID}" \
    --container-disk-in-gb 60 \
    --env '{"MODEL_PRECISION":"bf16"}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "template: ${TEMPLATE_ID}"

ENDPOINT_ID=$(runpodctl serverless create \
  --name flux-lora-train \
  --template-id "${TEMPLATE_ID}" \
  --gpu-id "NVIDIA L40S" \
  --workers-min 0 \
  --workers-max 1 \
  --idle-timeout 15 \
  --execution-timeout 3600 \
  --min-cuda-version 12.6 \
  --flash-boot \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "endpoint: ${ENDPOINT_ID}"

# 48 GB pools like the image endpoint (bf16 FLUX + rank-16 adapters at 512 px fit
# with gradient checkpointing), minus the Blackwell MIG slice the image's torch
# can't run on. 80 GB GPUs would be faster per step but were hard to get.
curl -sS -X PATCH "https://api.runpod.io/v2/serverless/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"gpu":{"pools":["ADA_48_PRO","AMPERE_48"],"excludedTypes":["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"]}}' \
  | python3 -c 'import json,sys; g=json.load(sys.stdin)["gpu"]; print("gpu pools:", g["pools"], "excluded:", g.get("excludedTypes"))'

echo "Next: add ${ENDPOINT_ID} to the app's restricted API key, then set RUNPOD_TRAIN_ENDPOINT_ID=${ENDPOINT_ID} on the app pod."
