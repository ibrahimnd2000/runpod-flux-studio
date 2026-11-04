#!/usr/bin/env bash
# Keep the demo responsive while people are looking at it, then go back to scale-to-zero.
#
#   scripts/warm_demo.sh on      # 1 active worker on the image and LLM endpoints (bills while idle!)
#   scripts/warm_demo.sh off     # back to min 0 (nothing bills when idle)
#   scripts/warm_demo.sh status  # workers and queue on both endpoints
#
# "on" also adds a bigger fallback pool after the usual ones (80 GB A100s for images, 48 GB for
# the LLM), so a shortage of one GPU size doesn't leave jobs queued; the fallbacks stay after "off". Video and LoRA training stay at
# scale-to-zero: they take minutes anyway and the app says so while they wait.
#
# Cost while on, at Runpod's flex list prices (bench/prices.yaml; active workers may be cheaper):
#   image worker $1.22-1.75/h on a 48 GB GPU ($2.72/h if placed on an A100), LLM worker up to $1.34/h.
#   24 hours: about $60-75, at most ~$100.
set -euo pipefail
: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY (or: set -a; source .env; set +a)}"
IMAGE_EP="${RUNPOD_IMAGE_ENDPOINT_ID:-y6hj5mx4y5b2su}"
LLM_EP="${RUNPOD_LLM_ENDPOINT_ID:-gdk2e7i6wa5zto}"

patch() { # endpoint, JSON body
  curl -sS -X PATCH "https://api.runpod.io/v2/serverless/$1" -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
    -H "Content-Type: application/json" -d "$2" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ", d.get("name") or d.get("id"), "workers:", d.get("workers"), "pools:", (d.get("gpu") or {}).get("pools"), d.get("error") or "")'
}

health() {
  for ep in "$IMAGE_EP" "$LLM_EP"; do
    echo "  $ep $(curl -sS "https://api.runpod.ai/v2/$ep/health" -H "Authorization: Bearer ${RUNPOD_API_KEY}")"
  done
}

case "${1:-status}" in
  on)
    patch "$IMAGE_EP" '{"workers":{"min":1,"max":1},"gpu":{"pools":["ADA_48_PRO","AMPERE_48","AMPERE_80"],"excludedTypes":["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"]}}'
    patch "$LLM_EP" '{"workers":{"min":1,"max":1},"gpu":{"pools":["AMPERE_24","ADA_24","AMPERE_48"],"excludedTypes":["NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb","NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"]}}'
    echo "Warm since $(date '+%a %d %b %H:%M'). Placing a worker can take 5-15 min (image pull)."
    echo "Billing until you run: scripts/warm_demo.sh off"
    ;;
  off)
    patch "$IMAGE_EP" '{"workers":{"min":0,"max":1}}'
    patch "$LLM_EP" '{"workers":{"min":0,"max":1}}'
    echo "Back to scale-to-zero."
    ;;
  status) health ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
