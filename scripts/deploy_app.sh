#!/usr/bin/env bash
# Host the Next.js demo app on a Runpod CPU pod (cpu3c, 2 vCPU / 4 GB, ~$0.06/h).
#
# Prerequisites (Runpod console -> Secrets), referenced by name only:
#   flux_demo_api_key       Runpod API key the app uses for /run, /status, /health
#   flux_demo_access_code   passphrase visitors enter to generate
#
#   export RUNPOD_API_KEY=...            # your key, only to call the pods API
#   export RUNPOD_IMAGE_ENDPOINT_ID=...
#   export NETWORK_VOLUME_ID=...         # runpodctl network-volume create --size 10 --data-center-id EU-RO-1
#   export DATA_CENTER_ID=EU-RO-1        # must match the volume's data center
#   scripts/deploy_app.sh
#
# The app is then served at https://<pod-id>-3000.proxy.runpod.net
set -euo pipefail

: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY}"
: "${RUNPOD_IMAGE_ENDPOINT_ID:?set RUNPOD_IMAGE_ENDPOINT_ID}"
: "${NETWORK_VOLUME_ID:?set NETWORK_VOLUME_ID (job history lives on it)}"
: "${DATA_CENTER_ID:?set DATA_CENTER_ID (data center of the network volume)}"
APP_IMAGE="${APP_IMAGE:-docker.io/ibrahimnd2000/flux-studio-app:v0.2.1}"

# runpodctl can't choose a CPU flavor/size, so this uses the REST v1 pods API.
BODY=$(APP_IMAGE="$APP_IMAGE" NETWORK_VOLUME_ID="$NETWORK_VOLUME_ID" DATA_CENTER_ID="$DATA_CENTER_ID" python3 - <<'PY'
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
    # A pod volume (volumeInGb) is not created for CPU pods, so job history lives on a
    # network volume. It pins the pod to the data center of that volume.
    "networkVolumeId": os.environ["NETWORK_VOLUME_ID"],
    "dataCenterIds": [os.environ["DATA_CENTER_ID"]],
    "volumeMountPath": "/workspace",
    "env": {
        # Resolved by Runpod at start; the values never appear in the pod config.
        "RUNPOD_API_KEY": "{{ RUNPOD_SECRET_flux_demo_api_key }}",
        "DEMO_ACCESS_CODE": "{{ RUNPOD_SECRET_flux_demo_access_code }}",
        "RUNPOD_IMAGE_ENDPOINT_ID": os.environ["RUNPOD_IMAGE_ENDPOINT_ID"],
        # Optional: enables Animate (LTX-2.5 image-to-video).
        "RUNPOD_VIDEO_ENDPOINT_ID": os.environ.get("RUNPOD_VIDEO_ENDPOINT_ID", ""),
        "VIDEO_DAILY_CAP": "20",
        "DATA_DIR": "/workspace/flux-app",
        "DAILY_JOB_CAP": "100",
        "RATE_LIMIT_PER_10_MIN": "12",
        "BULK_MAX": "8",
        "MAX_SIDE": "1024",
        "MAX_STEPS": "28",
    },
}))
PY
)

RESP=$(curl -sS -X POST https://rest.runpod.io/v1/pods \
  -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${BODY}")

RESP="$RESP" python3 - <<'PY'
import json, os
d = json.loads(os.environ["RESP"])
if "id" not in d:
    raise SystemExit(f"pod creation failed: {d}")
print(f"pod {d['id']}  ${d['costPerHr']}/h  https://{d['id']}-3000.proxy.runpod.net")
PY
