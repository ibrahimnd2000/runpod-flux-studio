"""
Runpod Serverless worker: FLUX.1-dev text-to-image.

The pipeline is loaded once at import time, so only the first request on a
cold worker pays the model load; warm requests reuse it. Each response reports
which GPU served it, whether it was that worker's first job, and the model load
time, so benchmarks can separate cold-start cost from inference cost.

Environment:
  MODEL_ID        Hugging Face repo id or local path (default black-forest-labs/FLUX.1-dev)
  MODEL_PRECISION "bf16" (default) or "fp8" (torchao float8 weights on the transformer)
  MOCK_PIPELINE   "1" to skip torch/diffusers and return synthetic images (local/CPU tests)
  BUCKET_*        S3-compatible storage for output="url" (see rp_upload)
  LORA_DIR        where downloaded LoRA files are cached (default /tmp/loras; one at a time)

Jobs with "task": "train_lora" fine-tune a LoRA instead (lora_train.py); a
generate job may name a LoRA ({"lora": {"id", "url", "scale"}}) to apply.
LoRA files are cached by id, so callers must treat an id as immutable.

Jobs run one at a time per worker (the default runpod handler), so the module-level
BACKEND and counters are not guarded; add locking before using concurrency_modifier.
"""

import base64
import io
import logging
import os
import random
import re
import sys
import time
import urllib.request
import uuid

PROCESS_START = time.perf_counter()

import runpod  # noqa: E402
from runpod.serverless.utils import rp_upload  # noqa: E402
from runpod.serverless.utils.rp_validator import validate  # noqa: E402

# lora_train.py sits next to this file (/app in the image; tests load us by path).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lora_train  # noqa: E402, I001

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("flux-worker")

MODEL_ID = os.environ.get("MODEL_ID", "black-forest-labs/FLUX.1-dev")
MODEL_PRECISION = os.environ.get("MODEL_PRECISION", "bf16").lower()
MOCK_PIPELINE = os.environ.get("MOCK_PIPELINE", "0") == "1"
# Set by Runpod on real workers; progress updates are only sent there.
WORKER_ID = os.environ.get("RUNPOD_POD_ID")
PROGRESS_INTERVAL_S = 1.0

MAX_PROMPT_CHARS = 1000
MIN_SIDE, MAX_SIDE, SIDE_MULTIPLE = 256, 1536, 16
MIN_STEPS, MAX_STEPS = 1, 50
MAX_IMAGES = 4
MAX_SEED = 2**32 - 1
MIN_GUIDANCE, MAX_GUIDANCE = 0.0, 20.0
MAX_LORA_SCALE = 2.0
ERROR_DETAIL_CHARS = 200  # of an unexpected exception's text, returned to the caller
LORA_DIR = os.environ.get("LORA_DIR", "/tmp/loras")
MAX_LORA_BYTES = 512 * 2**20
LORA_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

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
    "lora": {"type": dict, "required": False, "default": None},
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
        self.precision = precision
        self.lora_id = None  # the adapter currently loaded, if any
        self.load_ms = (time.perf_counter() - t0) * 1000
        props = torch.cuda.get_device_properties(0)
        self.device = {"gpu": props.name, "vram_total_gb": round(props.total_memory / 2**30, 1)}
        log.info("Loaded %s (%s) on %s in %.1fs", model_id, precision, props.name, self.load_ms / 1000)

    def use_lora(self, lora: dict | None):
        """Load (or unload) the requested LoRA. One adapter at a time: switching
        costs a second or two, keeping many would hold VRAM for idle adapters."""
        if lora and self.precision != "bf16":
            raise InputError("LoRAs need MODEL_PRECISION=bf16 on this endpoint")
        wanted = lora["id"] if lora else None
        if self.lora_id and self.lora_id != wanted:
            self.pipe.unload_lora_weights()
            self.lora_id = None
        if lora and self.lora_id != wanted:
            path = fetch_lora(lora)
            try:
                self.pipe.load_lora_weights(path, adapter_name="active")
            except Exception as e:
                # A bad file must not stick: drop it from the cache and any half-loaded
                # adapter from the pipe, so the next job (or a re-upload) starts clean.
                log.warning("LoRA %s failed to load: %s", lora["id"], e)
                os.remove(path)
                self.pipe.unload_lora_weights()
                raise InputError("the LoRA file could not be loaded (not a FLUX LoRA, or corrupted)") from None
            self.lora_id = wanted
        if lora:
            self.pipe.set_adapters(["active"], adapter_weights=[lora["scale"]])

    def generate(self, p: dict, on_step=None) -> list:
        self.use_lora(p.get("lora"))

        def callback(pipe, step, timestep, callback_kwargs):
            if on_step:
                on_step(step + 1, p["num_inference_steps"])
            return callback_kwargs

        self.torch.cuda.reset_peak_memory_stats()
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
                callback_on_step_end=callback,
            )
        return result.images

    def peak_vram_gb(self) -> float:
        return round(self.torch.cuda.max_memory_allocated() / 2**30, 1)

    def recover_from_oom(self):
        self.torch.cuda.empty_cache()


class MockBackend:
    """Deterministic gradient images; lets the handler run without a GPU."""

    def __init__(self):
        self.load_ms = 0.0
        self.device = {"gpu": "mock", "vram_total_gb": 0.0}
        log.info("MOCK_PIPELINE=1: using synthetic images, no model loaded")

    def use_lora(self, lora: dict | None):
        if lora:
            fetch_lora(lora)

    def generate(self, p: dict, on_step=None) -> list:
        from PIL import Image

        self.use_lora(p.get("lora"))
        if on_step:
            for step in range(1, p["num_inference_steps"] + 1):
                on_step(step, p["num_inference_steps"])
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

    def peak_vram_gb(self) -> float:
        return 0.0

    def recover_from_oom(self):
        pass


def load_backend():
    if MOCK_PIPELINE:
        return MockBackend()
    return FluxBackend(MODEL_ID, MODEL_PRECISION)


def fetch_lora(lora: dict) -> str:
    """Local path of a LoRA file, downloaded once per worker (ids are immutable).
    Only the newest file is kept: one adapter is loaded at a time, and container disk is small."""
    path = os.path.join(LORA_DIR, f"{lora['id']}.safetensors")
    if os.path.exists(path):
        return path
    os.makedirs(LORA_DIR, exist_ok=True)
    for old in os.listdir(LORA_DIR):
        os.remove(os.path.join(LORA_DIR, old))
    req = urllib.request.Request(lora["url"], headers={"User-Agent": "flux-worker"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            data = res.read(MAX_LORA_BYTES + 1)
    except Exception as e:
        raise InputError(f"could not download the LoRA: {type(e).__name__}") from None
    if len(data) > MAX_LORA_BYTES:
        raise InputError(f"the LoRA is larger than {MAX_LORA_BYTES // 2**20} MB")
    tmp = f"{path}.{uuid.uuid4().hex}.part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return path


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

    if p["lora"] is not None:
        lora = p["lora"]
        url = lora.get("url")
        if not lora_train.is_https_url(url):
            raise InputError("lora.url must be an https URL")
        if not isinstance(lora.get("id"), str) or not LORA_ID.match(lora["id"]):
            raise InputError("lora.id must be 1-64 letters, digits, '-' or '_'")
        try:
            scale = float(lora.get("scale", 1.0))
        except (TypeError, ValueError):
            raise InputError("lora.scale must be a number") from None
        if not 0.0 <= scale <= MAX_LORA_SCALE:
            raise InputError(f"lora.scale must be between 0 and {MAX_LORA_SCALE:g}")
        p["lora"] = {"id": lora["id"], "url": url, "scale": scale}

    notes = []
    p["width"] = _snap_side("width", p["width"], notes)
    p["height"] = _snap_side("height", p["height"], notes)
    p["num_inference_steps"] = _clamp("num_inference_steps", p["num_inference_steps"], MIN_STEPS, MAX_STEPS, notes)
    p["num_images"] = _clamp("num_images", p["num_images"], 1, MAX_IMAGES, notes)
    p["guidance_scale"] = _clamp("guidance_scale", p["guidance_scale"], MIN_GUIDANCE, MAX_GUIDANCE, notes)
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
READY_S = time.perf_counter() - PROCESS_START
_jobs_started = 0  # every job, so a failed first job still counts as the cold one
_jobs_served = 0  # successful ones


def make_progress_reporter(job):
    """Step callback that sends throttled `progress_update`s, visible in /status.
    Extra keyword values (training loss, say) are added to the update."""
    last_sent = [0.0]

    def report(step, total, **extra):
        now = time.perf_counter()
        if step < total and now - last_sent[0] < PROGRESS_INTERVAL_S:
            return
        last_sent[0] = now
        if WORKER_ID:
            runpod.serverless.progress_update(job, {"step": step, "total_steps": total, **extra})

    return report


def error_detail(e: Exception) -> str:
    """Short description of an unexpected error for the caller; the traceback is in the logs."""
    return f"{type(e).__name__}: {str(e)[:ERROR_DETAIL_CHARS]}"


def worker_info(cold_start: bool) -> dict:
    return {
        "id": WORKER_ID,
        **BACKEND.device,
        "peak_vram_gb": BACKEND.peak_vram_gb(),
        # First job on this worker process: it paid the model load below.
        "cold_start": cold_start,
        "model_load_ms": round(BACKEND.load_ms, 1),
        "process_ready_s": round(READY_S, 2),
        "jobs_served": _jobs_served,
    }


def train_handler(job, cold_start: bool):
    """task=train_lora: fine-tune, upload the adapter, report timings and loss."""
    global _jobs_served
    t_start = time.perf_counter()
    if MODEL_PRECISION != "bf16":
        return {"error": "LoRA training needs MODEL_PRECISION=bf16 on this endpoint"}
    report = make_progress_reporter(job)

    def on_progress(step, total, loss):
        report(step, total, loss=round(loss, 4))

    trainer = lora_train.MockTrainer() if MOCK_PIPELINE else lora_train.FluxTrainer(BACKEND.pipe)
    try:
        BACKEND.use_lora(None)  # train on the plain base model
        result = lora_train.run_training(trainer, job.get("input"), on_progress)
    except lora_train.TrainInputError as e:
        return {"error": str(e)}
    except lora_train.UploadError as e:
        log.exception("training job %s: uploading the adapter failed", job.get("id"))
        return {"error": f"training finished but uploading the adapter failed: {e}"}
    except Exception as e:
        log.exception("training job %s failed", job.get("id"))
        BACKEND.recover_from_oom()
        if "out of memory" in str(e).lower():
            return {"error": "GPU out of memory while training; try a lower resolution or rank"}
        return {"error": f"training failed: {error_detail(e)}"}
    _jobs_served += 1
    result["timings"]["total_ms"] = round((time.perf_counter() - t_start) * 1000, 1)
    result["worker"] = worker_info(cold_start)
    return result


TASKS = ("generate", "train_lora")


def handler(job):
    global _jobs_started, _jobs_served
    cold_start = _jobs_started == 0
    _jobs_started += 1
    raw = job.get("input")
    task = raw.get("task", "generate") if isinstance(raw, dict) else "generate"
    if task not in TASKS:
        return {"error": f"unknown task {task!r}; use one of {', '.join(TASKS)}"}
    if task == "train_lora":
        return train_handler(job, cold_start)
    t_start = time.perf_counter()
    job_id = job.get("id") or str(uuid.uuid4())
    try:
        p, notes = normalize_input({k: v for k, v in raw.items() if k != "task"} if isinstance(raw, dict) else raw)
    except InputError as e:
        return {"error": str(e)}

    try:
        t_inf = time.perf_counter()
        images = BACKEND.generate(p, on_step=make_progress_reporter(job))
    except InputError as e:
        return {"error": str(e)}
    except Exception as e:  # never let one bad job kill the worker loop
        log.exception("job %s failed", job_id)
        if "out of memory" in str(e).lower():
            BACKEND.recover_from_oom()
            return {"error": "GPU out of memory; try a smaller size or fewer images"}
        return {"error": f"generation failed: {error_detail(e)}"}

    inference_ms = (time.perf_counter() - t_inf) * 1000
    try:
        t_enc = time.perf_counter()
        outputs = deliver(images, job_id, p)
        encode_ms = (time.perf_counter() - t_enc) * 1000
    except Exception as e:
        log.exception("job %s: delivering images failed", job_id)
        return {"error": f"delivering images failed: {error_detail(e)}"}

    _jobs_served += 1
    response = {
        "images": outputs,
        "seed": p["seed"],
        "timings": {
            "inference_ms": round(inference_ms, 1),
            "encode_ms": round(encode_ms, 1),
            "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
        },
        "worker": worker_info(cold_start),
        "params": {k: v for k, v in p.items() if k not in ("prompt", "lora")}
        | {"model": MODEL_ID, "precision": MODEL_PRECISION}
        | ({"lora": {"id": p["lora"]["id"], "scale": p["lora"]["scale"]}} if p["lora"] else {}),
    }
    if notes:
        response["notes"] = notes
    return response


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
