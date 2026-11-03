"""
Runpod Serverless worker: FLUX.1-dev text-to-image.

The pipeline is loaded once at import time, so only the first request on a
cold worker pays the model load; warm requests reuse it.

Environment:
  MODEL_ID        Hugging Face repo id or local path (default black-forest-labs/FLUX.1-dev)
  MODEL_PRECISION "bf16" (default) or "fp8" (torchao float8 weights on the transformer)
  MOCK_PIPELINE   "1" to skip torch/diffusers and return synthetic images (local/CPU tests)
  BUCKET_*        S3-compatible storage for output="url" (see rp_upload)
"""

import base64
import io
import logging
import os
import random
import time
import traceback
import uuid

import runpod
from runpod.serverless.utils import rp_upload
from runpod.serverless.utils.rp_validator import validate

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flux-worker")

MODEL_ID = os.environ.get("MODEL_ID", "black-forest-labs/FLUX.1-dev")
MODEL_PRECISION = os.environ.get("MODEL_PRECISION", "bf16").lower()
MOCK_PIPELINE = os.environ.get("MOCK_PIPELINE", "0") == "1"

MAX_PROMPT_CHARS = 1000
MIN_SIDE, MAX_SIDE, SIDE_MULTIPLE = 256, 1536, 16
MIN_STEPS, MAX_STEPS = 1, 50
MAX_IMAGES = 4
MAX_SEED = 2**32 - 1

# Types, required flags and defaults are checked by the Runpod SDK validator.
# Range clamping happens afterwards in normalize_input() so callers get a
# usable result plus a note instead of a hard failure for out-of-range sizes.
INPUT_SCHEMA = {
    "prompt": {"type": str, "required": True},
    "width": {"type": int, "required": False, "default": 1024},
    "height": {"type": int, "required": False, "default": 1024},
    "num_inference_steps": {"type": int, "required": False, "default": 28},
    "guidance_scale": {"type": float, "required": False, "default": 3.5},
    "seed": {"type": int, "required": False, "default": None},
    "num_images": {"type": int, "required": False, "default": 1},
    "output": {"type": str, "required": False, "default": "base64"},
    "image_format": {"type": str, "required": False, "default": "png"},
}


class InputError(ValueError):
    """Bad request from the caller; message is returned verbatim."""


# --------------------------------------------------------------------------- #
#                                  Backends                                   #
# --------------------------------------------------------------------------- #
class FluxBackend:
    """diffusers FluxPipeline on a single CUDA GPU."""

    def __init__(self, model_id: str, precision: str):
        import torch
        from diffusers import FluxPipeline

        self.torch = torch
        t0 = time.perf_counter()
        self.pipe = FluxPipeline.from_pretrained(model_id, torch_dtype=torch.bfloat16)
        if precision == "fp8":
            from torchao.quantization import Float8WeightOnlyConfig, quantize_

            quantize_(self.pipe.transformer, Float8WeightOnlyConfig())
        elif precision != "bf16":
            raise ValueError(f"Unknown MODEL_PRECISION {precision!r}; use bf16 or fp8")
        self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)
        log.info("Loaded %s (%s) in %.1fs", model_id, precision, time.perf_counter() - t0)

    def generate(self, p: dict) -> list:
        generator = self.torch.Generator(device="cuda").manual_seed(p["seed"])
        with self.torch.inference_mode():
            result = self.pipe(
                prompt=p["prompt"],
                width=p["width"],
                height=p["height"],
                num_inference_steps=p["num_inference_steps"],
                guidance_scale=p["guidance_scale"],
                num_images_per_prompt=p["num_images"],
                generator=generator,
            )
        return result.images

    def recover_from_oom(self):
        self.torch.cuda.empty_cache()


class MockBackend:
    """Deterministic gradient images; lets the handler run without a GPU."""

    def __init__(self):
        log.info("MOCK_PIPELINE=1: using synthetic images, no model loaded")

    def generate(self, p: dict) -> list:
        from PIL import Image

        rng = random.Random(p["seed"])
        images = []
        for _ in range(p["num_images"]):
            a = tuple(rng.randrange(256) for _ in range(3))
            b = tuple(rng.randrange(256) for _ in range(3))
            strip = Image.new("RGB", (p["width"], 1))
            for x in range(p["width"]):
                t = x / max(p["width"] - 1, 1)
                strip.putpixel((x, 0), tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
            images.append(strip.resize((p["width"], p["height"])))
        return images

    def recover_from_oom(self):
        pass


def load_backend():
    if MOCK_PIPELINE:
        return MockBackend()
    return FluxBackend(MODEL_ID, MODEL_PRECISION)


# --------------------------------------------------------------------------- #
#                                   Input                                     #
# --------------------------------------------------------------------------- #
def _clamp(name, value, lo, hi, notes):
    clamped = min(max(value, lo), hi)
    if clamped != value:
        notes.append(f"{name} clamped from {value} to {clamped}")
    return clamped


def _snap_side(name, value, notes):
    snapped = _clamp(name, value, MIN_SIDE, MAX_SIDE, notes)
    rounded = round(snapped / SIDE_MULTIPLE) * SIDE_MULTIPLE
    if rounded != snapped:
        notes.append(f"{name} rounded from {snapped} to {rounded} (multiple of {SIDE_MULTIPLE})")
    return rounded


def normalize_input(raw) -> tuple[dict, list]:
    """Validate and clamp job input. Returns (params, notes) or raises InputError."""
    if not isinstance(raw, dict):
        raise InputError("input must be a JSON object")
    if "negative_prompt" in raw:
        raise InputError(
            "negative_prompt is not supported: FLUX.1-dev is guidance-distilled and "
            "does not run classifier-free guidance, so there is no negative branch. "
            "Describe what you want in the prompt instead."
        )

    result = validate(raw, INPUT_SCHEMA)
    if "errors" in result:
        raise InputError("; ".join(result["errors"]))
    p = result["validated_input"]

    p["prompt"] = p["prompt"].strip()
    if not p["prompt"]:
        raise InputError("prompt must be a non-empty string")
    if len(p["prompt"]) > MAX_PROMPT_CHARS:
        raise InputError(f"prompt is {len(p['prompt'])} chars; max is {MAX_PROMPT_CHARS}")

    if p["output"] not in ("base64", "url"):
        raise InputError("output must be 'base64' or 'url'")
    if p["output"] == "url" and not os.environ.get("BUCKET_ENDPOINT_URL"):
        raise InputError("output='url' needs bucket storage configured on the endpoint (BUCKET_ENDPOINT_URL)")
    p["image_format"] = p["image_format"].lower()
    if p["image_format"] not in ("png", "jpeg"):
        raise InputError("image_format must be 'png' or 'jpeg'")

    if p["seed"] is None:
        p["seed"] = random.randint(0, MAX_SEED)
    elif not 0 <= p["seed"] <= MAX_SEED:
        raise InputError(f"seed must be between 0 and {MAX_SEED}")

    notes = []
    p["width"] = _snap_side("width", p["width"], notes)
    p["height"] = _snap_side("height", p["height"], notes)
    p["num_inference_steps"] = _clamp("num_inference_steps", p["num_inference_steps"], MIN_STEPS, MAX_STEPS, notes)
    p["num_images"] = _clamp("num_images", p["num_images"], 1, MAX_IMAGES, notes)
    p["guidance_scale"] = _clamp("guidance_scale", p["guidance_scale"], 0.0, 20.0, notes)
    return p, notes


# --------------------------------------------------------------------------- #
#                                   Output                                    #
# --------------------------------------------------------------------------- #
def encode_image(image, fmt: str) -> bytes:
    buf = io.BytesIO()
    if fmt == "jpeg":
        image.save(buf, format="JPEG", quality=92)
    else:
        image.save(buf, format="PNG")
    return buf.getvalue()


def deliver(images, job_id: str, p: dict) -> list:
    ext = "jpg" if p["image_format"] == "jpeg" else "png"
    out = []
    for i, image in enumerate(images):
        data = encode_image(image, p["image_format"])
        if p["output"] == "url":
            out.append(
                rp_upload.upload_in_memory_object(
                    f"{i}.{ext}",
                    data,
                    bucket_name=os.environ.get("BUCKET_NAME"),
                    prefix=f"flux/{job_id}",
                )
            )
        else:
            out.append(base64.b64encode(data).decode("ascii"))
    return out


# --------------------------------------------------------------------------- #
#                                  Handler                                    #
# --------------------------------------------------------------------------- #
BACKEND = load_backend()


def handler(job):
    t_start = time.perf_counter()
    job_id = job.get("id") or str(uuid.uuid4())
    try:
        p, notes = normalize_input(job.get("input"))
    except InputError as e:
        return {"error": str(e)}

    try:
        t_inf = time.perf_counter()
        images = BACKEND.generate(p)
        inference_ms = (time.perf_counter() - t_inf) * 1000
        outputs = deliver(images, job_id, p)
    except Exception as e:  # never let one bad job kill the worker loop
        log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
        if "out of memory" in str(e).lower():
            BACKEND.recover_from_oom()
            return {"error": "GPU out of memory; try a smaller size or fewer images"}
        return {"error": f"generation failed: {type(e).__name__}: {e}"}

    response = {
        "images": outputs,
        "seed": p["seed"],
        "timings": {
            "inference_ms": round(inference_ms, 1),
            "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
        },
        "params": {k: v for k, v in p.items() if k != "prompt"} | {"model": MODEL_ID, "precision": MODEL_PRECISION},
    }
    if notes:
        response["notes"] = notes
    return response


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
