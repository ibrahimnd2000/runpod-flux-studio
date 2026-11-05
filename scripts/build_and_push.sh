#!/usr/bin/env bash
# Build the FLUX.1-dev worker for linux/amd64 and push it to a registry.
#
#   hf auth login                  # or: export HF_TOKEN=... (needs FLUX.1-dev access)
#   export REGISTRY=docker.io      # or ghcr.io
#   export REGISTRY_USER=<user>
#   export IMAGE_TAG=v0.3.1
#   scripts/build_and_push.sh
#
# The token is passed as a BuildKit secret, so it never appears in a layer, in
# `docker history`, or in this script's output.
set -euo pipefail

HF_TOKEN_FILE="${HF_TOKEN_FILE:-${HF_HOME:-$HOME/.cache/huggingface}/token}"
if [[ -n "${HF_TOKEN:-}" ]]; then
  SECRET_ARG="id=hf_token,env=HF_TOKEN"
elif [[ -s "${HF_TOKEN_FILE}" ]]; then
  SECRET_ARG="id=hf_token,src=${HF_TOKEN_FILE}"
else
  echo "No HF token: set HF_TOKEN or run 'hf auth login'" >&2
  exit 1
fi
: "${REGISTRY_USER:?REGISTRY_USER must be set}"
REGISTRY="${REGISTRY:-docker.io}"
IMAGE_TAG="${IMAGE_TAG:-v0.3.1}"
IMAGE="${REGISTRY}/${REGISTRY_USER}/flux-worker:${IMAGE_TAG}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building ${IMAGE}"
docker buildx build \
  --platform linux/amd64 \
  --secret "${SECRET_ARG}" \
  --tag "${IMAGE}" \
  --push \
  "${ROOT}/workers/image"

echo "Pushed ${IMAGE}"
