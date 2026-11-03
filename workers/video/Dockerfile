# syntax=docker/dockerfile:1.7
#
# LTX-2.5 image-to-video Runpod Serverless worker. No weights in the image: the
# endpoint is created with Runpod model caching (--model-reference), which mounts
# the Hugging Face snapshot under /runpod-volume/huggingface-cache/hub.
#
#   docker buildx build --platform linux/amd64 -t <registry>/<user>/ltx-video-worker:<tag> workers/video
#
# Stages: deps -> check (CI: imports the real LTX-2 pipeline classes) -> final.

FROM pytorch/pytorch:2.14.1-cuda12.6-cudnn9-runtime AS deps

# The base image ships torch in the system Python 3.12 (PEP 668); single-purpose container.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# git: diffusers is installed from a pinned main-branch commit.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Constrain torch to the base image's CUDA build so no dependency can replace it.
COPY requirements.txt .
RUN python -c "import torch; print('torch==' + torch.__version__)" > /tmp/torch-constraint.txt \
    && pip install -r requirements.txt -c /tmp/torch-constraint.txt


# CI-only: proves the pinned stack imports LTX-2.5's pipeline and Gemma 4 encoder.
FROM deps AS check
COPY handler.py .
RUN python -c "import diffusers, transformers, av; \
from diffusers import LTX2ImageToVideoPipeline; \
from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES; \
from diffusers.utils import encode_video; \
from transformers import Gemma4UnifiedForConditionalGeneration; \
print('diffusers', diffusers.__version__, 'transformers', transformers.__version__, 'av', av.__version__)" \
    && MOCK_PIPELINE=1 python -c "import handler"


FROM deps AS final
# Weights come from Runpod's model cache only (see handler.py); never download at runtime.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    MODEL_STORE_DIR=/runpod/model-store/huggingface
COPY handler.py .
CMD ["python", "-u", "handler.py"]
