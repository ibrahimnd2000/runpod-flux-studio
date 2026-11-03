#!/usr/bin/env bash
# Host the Next.js demo app on a Runpod CPU pod (cpu3c, 2 vCPU / 4 GB, ~$0.06/h).
#
# Prerequisites (Runpod console -> Secrets), referenced by name only:
#   flux_demo_api_key       Runpod API key the app uses for /run, /status, /health
#   flux_demo_access_code   passphrase visitors enter to generate
#
#   export RUNPOD_API_KEY=...            # your key, only to call the pods API
#   export RUNPOD_IMAGE_ENDPOINT_ID=...
#   scripts/deploy_app.sh
#
# The app is then served at https://<pod-id>-3000.proxy.runpod.net
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY}"
: "${RUNPOD_IMAGE_ENDPOINT_ID:?set RUNPOD_IMAGE_ENDPOINT_ID}"
APP_IMAGE="${APP_IMAGE:-docker.io/ibrahimnd2000/flux-studio-app:v0.1.1}"

# runpodctl can't choose a CPU flavor/size, so this uses the REST v1 pods API.
BODY=$(APP_IMAGE="$APP_IMAGE" python3 - <<'PY'
import json, os
print(json.dumps({
    "name": "flux-studio-app",
    "computeType": "CPU",
    "cpuFlavorIds": ["cpu3c"],
    "vcpuCount": 2,
    "cloudType": "SECURE",
    "imageName": os.environ["APP_IMAGE"],
    "ports": ["3000/http"],
    "containerDiskInGb": 5,
    "volumeInGb": 1,  # job history (DATA_DIR) survives pod restarts
    "volumeMountPath": "/workspace",
    "env": {
        # Resolved by Runpod at start; the values never appear in the pod config.
        "RUNPOD_API_KEY": "{{ RUNPOD_SECRET_flux_demo_api_key }}",
        "DEMO_ACCESS_CODE": "{{ RUNPOD_SECRET_flux_demo_access_code }}",
        "RUNPOD_IMAGE_ENDPOINT_ID": os.environ["RUNPOD_IMAGE_ENDPOINT_ID"],
        "DATA_DIR": "/workspace/flux-app",
        "DAILY_JOB_CAP": "100",
        "RATE_LIMIT_PER_10_MIN": "6",
        "MAX_SIDE": "1024",
        "MAX_STEPS": "28",
    },
}))
PY
)

curl -sS -X POST https://rest.runpod.io/v1/pods \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${BODY}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("pod:", d["id"], f"${d[\"costPerHr\"]}/h", f"https://{d[\"id\"]}-3000.proxy.runpod.net")'
