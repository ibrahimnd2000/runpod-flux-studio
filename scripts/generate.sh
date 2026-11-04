#!/usr/bin/env bash
# Generate an image from the deployed endpoint and save it as a PNG.
#
#   export RUNPOD_API_KEY=... RUNPOD_IMAGE_ENDPOINT_ID=...
#   scripts/generate.sh "a ceramic mug on a walnut table, morning light" [out.png]
#
# Uses /runsync (waits for the result). For long jobs use /run + /status, see
# scripts/curl_examples.md.
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY}"
: "${RUNPOD_IMAGE_ENDPOINT_ID:?set RUNPOD_IMAGE_ENDPOINT_ID}"
PROMPT="${1:?usage: $0 \"prompt\" [out.png]}"
OUT="${2:-out/flux-$(date +%Y%m%d-%H%M%S).png}"
mkdir -p "$(dirname "$OUT")"

BODY=$(python3 -c 'import json,sys; print(json.dumps({"input": {"prompt": sys.argv[1], "seed": 42}}))' "$PROMPT")

# The response carries the image as ~1.5 MB of base64: too big for an env var or argument
# ("Argument list too long" on macOS), so it goes through a temp file.
RESP=$(mktemp)
trap 'rm -f "$RESP"' EXIT
curl -sS -X POST "https://api.runpod.ai/v2/${RUNPOD_IMAGE_ENDPOINT_ID}/runsync" \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$BODY" -o "$RESP"

python3 - "$OUT" "$RESP" <<'PY'
import base64, json, sys
r = json.load(open(sys.argv[2]))
if r.get("status") != "COMPLETED":
    sys.exit(f"job {r.get('id')} status={r.get('status')} error={r.get('error') or r.get('output')}")
out = r["output"]
open(sys.argv[1], "wb").write(base64.b64decode(out["images"][0]))
print(f"saved {sys.argv[1]}  seed={out['seed']}  inference={out['timings']['inference_ms']:.0f}ms"
      f"  delayTime={r.get('delayTime', 'n/a')}ms  executionTime={r.get('executionTime', 'n/a')}ms")
PY
