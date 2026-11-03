#!/usr/bin/env bash
# Build the FLUX.1-dev worker for linux/amd64 and push it to a registry.
#
#   export HF_TOKEN=...            # read access to black-forest-labs/FLUX.1-dev
#   export REGISTRY=docker.io      # or ghcr.io
#   export REGISTRY_USER=<user>
#   export IMAGE_TAG=v0.1.0
#   scripts/build_and_push.sh
#
# The token is passed as a BuildKit secret (env source), so it never appears in
# a layer, in `docker history`, or in this script's output.
set -euo pipefail

: "${HF_TOKEN:?HF_TOKEN must be set}"
: "${REGISTRY_USER:?REGISTRY_USER must be set}"
REGISTRY="${REGISTRY:-docker.io}"
IMAGE_TAG="${IMAGE_TAG:-v0.1.0}"
IMAGE="${REGISTRY}/${REGISTRY_USER}/flux-worker:${IMAGE_TAG}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building ${IMAGE}"
docker buildx build \
  --platform linux/amd64 \
  --secret id=hf_token,env=HF_TOKEN \
  --tag "${IMAGE}" \
  --push \
  "${ROOT}/workers/image"

echo "Pushed ${IMAGE}"
