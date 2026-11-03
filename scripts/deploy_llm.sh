#!/usr/bin/env bash
# Runpod Serverless vLLM endpoint for the open-model agents (OpenAI-compatible
# route with tool calling), using Runpod's official worker image.
#
#   export RUNPOD_API_KEY=...        # or: set -a; source .env; set +a
#   scripts/deploy_llm.sh
#
# Qwen3-8B in BF16 (~16 GB) on 24 GB GPUs; model caching places the weights on the
# host, so a cold start doesn't download them. Scale to zero: billed only while a
# worker runs (24 GB pool list price, ~$0.76/h at the time of writing).
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (needed to set GPU pools)}"
IMAGE="${IMAGE:-runpod/worker-v1-vllm:v2.30.2}"
MODEL="${MODEL:-Qwen/Qwen3-8B}"

if [[ -z "${TEMPLATE_ID:-}" ]]; then
  ENV=$(MODEL="$MODEL" python3 -c 'import json,os; print(json.dumps({
    "MODEL_NAME": os.environ["MODEL"],
    "MAX_MODEL_LEN": "16384",
    "GPU_MEMORY_UTILIZATION": "0.92",
    "ENABLE_AUTO_TOOL_CHOICE": "true",
    "TOOL_CALL_PARSER": "hermes",
    "OPENAI_SERVED_MODEL_NAME_OVERRIDE": os.environ["MODEL"],
  }))')
  TEMPLATE_ID=$(runpodctl template create \
    --name "agent-llm-${MODEL##*/}" \
    --image "${IMAGE}" \
    --serverless \
    --container-disk-in-gb 20 \
    --env "${ENV}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
fi
echo "template: ${TEMPLATE_ID}"

ENDPOINT_ID=$(runpodctl serverless create \
  --name agent-llm \
  --template-id "${TEMPLATE_ID}" \
  --gpu-id "NVIDIA L4" \
  --model-reference "https://huggingface.co/${MODEL}:main" \
  --workers-min 0 \
  --workers-max 1 \
  --idle-timeout 120 \
  --execution-timeout 600 \
  --min-cuda-version 12.8 \
  --flash-boot \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "endpoint: ${ENDPOINT_ID}"

# 24 GB pools, minus the Blackwell MIG slice.
curl -sS -X PATCH "https://api.runpod.io/v2/serverless/${ENDPOINT_ID}" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"gpu":{"pools":["AMPERE_24","ADA_24"],"excludedTypes":["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb"],"minCudaVersion":"12.8"}}' \
  | python3 -c 'import json,sys; g=json.load(sys.stdin)["gpu"]; print("gpu pools:", g["pools"], "excluded:", g.get("excludedTypes"))'
echo "set RUNPOD_LLM_ENDPOINT_ID=${ENDPOINT_ID} for the app"
