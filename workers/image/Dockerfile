# syntax=docker/dockerfile:1.7
#
# FLUX.1-dev Runpod Serverless worker with weights baked into the image.
#
# Build (the HF token is a BuildKit secret: it is mounted only for the download
# step and never written to a layer, the build log or image metadata):
#   docker buildx build --platform linux/amd64 \
#     --secret id=hf_token,env=HF_TOKEN \
#     -t <registry>/<user>/flux-worker:<tag> workers/image
#
# Stages: deps -> weights (~34 GB) -> final (code). Editing handler.py rebuilds
# and re-pushes only the last, few-KB layer. `--target check` builds deps plus
# the code without weights or a token, which is what CI runs.

FROM pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime AS deps

# The base image ships torch in the system Python 3.12 (PEP 668 "externally
# managed"); this container has a single purpose, so install alongside it.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /app

# Constrain torch to the base image's CUDA build so no dependency can replace it.
COPY requirements.txt .
RUN python -c "import torch; print('torch==' + torch.__version__)" > /tmp/torch-constraint.txt \
    && pip install -r requirements.txt -c /tmp/torch-constraint.txt


# CI-only: proves the pinned stack imports on the real base image.
FROM deps AS check
COPY handler.py .
RUN python -c "import diffusers, transformers, torchao; from diffusers import FluxPipeline; \
print('diffusers', diffusers.__version__, 'transformers', transformers.__version__)" \
    && MOCK_PIPELINE=1 python -c "import handler"


FROM deps AS weights
# Diffusers-format folders only (transformer, T5, CLIP, VAE, configs). The repo
# also ships flux1-dev.safetensors and ae.safetensors (original-format duplicates,
# ~24 GB) that diffusers does not use, so they are excluded.
ARG MODEL_REPO=black-forest-labs/FLUX.1-dev
ARG MODEL_REVISION=3de623fc3c33e44ffbe2bad470d0f45bccf2eb21
ENV MODEL_ID=/models/FLUX.1-dev
RUN --mount=type=secret,id=hf_token,required=true \
    HF_TOKEN="$(cat /run/secrets/hf_token)" python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('${MODEL_REPO}', revision='${MODEL_REVISION}', local_dir='${MODEL_ID}', \
    allow_patterns=['model_index.json', 'scheduler/*', 'text_encoder/*', 'text_encoder_2/*', \
                    'tokenizer/*', 'tokenizer_2/*', 'transformer/*', 'vae/*'])" \
    && rm -rf "${MODEL_ID}/.cache"


FROM weights AS final
# Weights are local: never call the Hub at runtime (no token on the worker,
# no surprise downloads on cold start).
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    MODEL_PRECISION=bf16

COPY handler.py .

CMD ["python", "-u", "handler.py"]
