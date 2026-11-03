"""
Runpod Serverless worker: LTX-2.5 (distilled) image-to-video with audio.

Weights come from Runpod model caching (endpoint created with --model-reference),
mounted under /runpod-volume/huggingface-cache/hub, so the image stays small and
the 72 GB of weights never travel through a registry. The pipeline is loaded
once at import time; warm requests reuse it.

Environment:
  MODEL_ID         Hugging Face repo id (default Lightricks/LTX-2.5-Diffusers)
  MODEL_CACHE_DIR  Runpod model cache root (default /runpod-volume/huggingface-cache/hub)
  OFFLOAD          "model" (default: components move to the GPU only while used) or "none"
  MAX_RESULT_MB    refuse results whose base64 MP4 exceeds this (default 15)
  MOCK_PIPELINE    "1" to skip torch/diffusers and return a synthetic clip (local/CPU tests)
"""

import base64
import io
import logging
import os
import random
import tempfile
import time
import traceback
import urllib.request
import uuid

PROCESS_START = time.perf_counter()

import runpod  # noqa: E402
from runpod.serverless.utils.rp_validator import validate  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ltx-worker")

MODEL_ID = os.environ.get("MODEL_ID", "Lightricks/LTX-2.5-Diffusers")
MODEL_CACHE_DIR = os.environ.get("MODEL_CACHE_DIR", "/runpod-volume/huggingface-cache/hub")
OFFLOAD = os.environ.get("OFFLOAD", "model").lower()
MAX_RESULT_MB = float(os.environ.get("MAX_RESULT_MB", "15"))
MOCK_PIPELINE = os.environ.get("MOCK_PIPELINE", "0") == "1"
WORKER_ID = os.environ.get("RUNPOD_POD_ID")
PROGRESS_INTERVAL_S = 1.0

MAX_PROMPT_CHARS = 1000
MAX_IMAGE_BYTES = 8 * 2**20  # /run accepts 10 MB in total
MAX_SEED = 2**32 - 1
MIN_FRAMES, MAX_FRAMES = 9, 241  # 241 frames = 10 s at 24 fps
# Landscape sizes; portrait inputs get width and height swapped. Divisible by 32.
RESOLUTIONS = {"540p": (960, 544), "720p": (1280, 704)}

INPUT_SCHEMA = {
    "image": {"type": str, "required": True},
    "prompt": {"type": str, "required": True},
    "resolution": {"type": str, "required": False, "default": "540p"},
    "num_frames": {"type": int, "required": False, "default": 121},
    "fps": {"type": int, "required": False, "default": 24},
    "seed": {"type": int, "required": False, "default": None},
    "audio": {"type": bool, "required": False, "default": True},
}


class InputError(ValueError):
    """Bad request from the caller; message is returned verbatim."""


# --------------------------------------------------------------------------- #
#                                  Backends                                   #
# --------------------------------------------------------------------------- #
def resolve_model_path(model_id: str, cache_dir: str) -> str:
    """Local snapshot from Runpod's model cache if present, else the repo id (downloads, needs HF_TOKEN)."""
    snapshots = os.path.join(cache_dir, "models--" + model_id.replace("/", "--"), "snapshots")
    if os.path.isdir(snapshots):
        versions = sorted(
            (os.path.join(snapshots, d) for d in os.listdir(snapshots)), key=os.path.getmtime, reverse=True
        )
        if versions:
            return versions[0]
    log.warning("No cached snapshot under %s; falling back to downloading %s", snapshots, model_id)
    return model_id


class LTXBackend:
    """diffusers LTX2ImageToVideoPipeline, distilled 8-step schedule, on one CUDA GPU."""

    def __init__(self, model_id: str):
        import torch
        from diffusers import LTX2ImageToVideoPipeline
        from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES

        self.torch = torch
        self.sigmas = DISTILLED_SIGMA_VALUES
        path = resolve_model_path(model_id, MODEL_CACHE_DIR)
        t0 = time.perf_counter()
        self.pipe = LTX2ImageToVideoPipeline.from_pretrained(path, torch_dtype=torch.bfloat16)
        if OFFLOAD == "model":
            self.pipe.enable_model_cpu_offload()
        else:
            self.pipe.to("cuda")
        self.pipe.vae.enable_tiling()
        self.pipe.set_progress_bar_config(disable=True)
        self.load_ms = (time.perf_counter() - t0) * 1000
        props = torch.cuda.get_device_properties(0)
        self.device = {"gpu": props.name, "vram_total_gb": round(props.total_memory / 2**30, 1)}
        self.audio_rate = self.pipe.vocoder.config.output_sampling_rate
        log.info(
            "Loaded %s from %s on %s in %.1fs (offload=%s)", model_id, path, props.name, self.load_ms / 1000, OFFLOAD
        )

    def generate(self, p: dict, image, on_step=None):
        def callback(pipe, step, timestep, callback_kwargs):
            if on_step:
                on_step(step + 1, len(self.sigmas))
            return callback_kwargs

        self.torch.cuda.reset_peak_memory_stats()
        generator = self.torch.Generator(device="cuda").manual_seed(p["seed"])
        with self.torch.inference_mode():
            video, audio = self.pipe(
                image=image,
                prompt=p["prompt"],
                width=p["width"],
                height=p["height"],
                num_frames=p["num_frames"],
                frame_rate=float(p["fps"]),
                sigmas=self.sigmas,
                guidance_scale=1.0,  # distilled checkpoint: no CFG
                generator=generator,
                output_type="np",
                return_dict=False,
                callback_on_step_end=callback,
            )
        return video[0], (audio[0].float().cpu() if p["audio"] else None)

    def encode(self, frames, audio, fps: int) -> bytes:
        from diffusers.utils import encode_video

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "clip.mp4")
            encode_video(
                frames,
                fps=fps,
                output_path=path,
                audio=audio,
                audio_sample_rate=self.audio_rate if audio is not None else None,
            )
            with open(path, "rb") as f:
                return f.read()

    def peak_vram_gb(self) -> float:
        return round(self.torch.cuda.max_memory_allocated() / 2**30, 1)


class MockBackend:
    """Synthetic clip (a few tiny frames) so the handler runs without a GPU."""

    def __init__(self):
        self.load_ms = 0.0
        self.device = {"gpu": "mock", "vram_total_gb": 0.0}
        log.info("MOCK_PIPELINE=1: synthetic video, no model loaded")

    def generate(self, p: dict, image, on_step=None):
        if on_step:
            for step in range(1, 9):
                on_step(step, 8)
        return {"frames": p["num_frames"], "size": (p["width"], p["height"])}, None

    def encode(self, frames, audio, fps: int) -> bytes:
        # Not a playable MP4; just bytes with an MP4 signature for shape tests.
        return b"\x00\x00\x00\x18ftypmp42" + str(frames).encode() * 10

    def peak_vram_gb(self) -> float:
        return 0.0


def load_backend():
    return MockBackend() if MOCK_PIPELINE else LTXBackend(MODEL_ID)


# --------------------------------------------------------------------------- #
#                                   Input                                     #
# --------------------------------------------------------------------------- #
def load_image(ref: str):
    """`image` is an https URL, a data URI or raw base64. Returns an RGB PIL image."""
    from PIL import Image

    if ref.startswith(("http://", "https://")):
        if not ref.startswith("https://"):
            raise InputError("image URL must use https")
        try:
            with urllib.request.urlopen(ref, timeout=20) as resp:
                data = resp.read(MAX_IMAGE_BYTES + 1)
        except Exception as e:
            raise InputError(f"could not download image: {e}") from e
    else:
        b64 = ref.split(",", 1)[1] if ref.startswith("data:") else ref
        try:
            data = base64.b64decode(b64, validate=True)
        except Exception as e:
            raise InputError("image must be an https URL, a data URI or base64") from e
    if len(data) > MAX_IMAGE_BYTES:
        raise InputError(f"image is larger than {MAX_IMAGE_BYTES // 2**20} MB")
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:
        raise InputError("image could not be decoded") from e
    return img.convert("RGB")


def snap_frames(n: int) -> int:
    """LTX needs 8k+1 frames."""
    n = min(max(n, MIN_FRAMES), MAX_FRAMES)
    return ((n - 1 + 4) // 8) * 8 + 1


def normalize_input(raw) -> tuple[dict, list, object]:
    if not isinstance(raw, dict):
        raise InputError("input must be a JSON object")
    result = validate(raw, INPUT_SCHEMA)
    if "errors" in result:
        raise InputError("; ".join(result["errors"]))
    p = result["validated_input"]

    p["prompt"] = p["prompt"].strip()
    if not p["prompt"]:
        raise InputError("prompt must describe the motion, e.g. 'slow camera push-in, steam rising'")
    if len(p["prompt"]) > MAX_PROMPT_CHARS:
        raise InputError(f"prompt is {len(p['prompt'])} chars; max is {MAX_PROMPT_CHARS}")
    if p["resolution"] not in RESOLUTIONS:
        raise InputError(f"resolution must be one of {', '.join(RESOLUTIONS)}")
    if p["seed"] is None:
        p["seed"] = random.randint(0, MAX_SEED)
    elif not 0 <= p["seed"] <= MAX_SEED:
        raise InputError(f"seed must be between 0 and {MAX_SEED}")

    notes = []
    frames = snap_frames(p["num_frames"])
    if frames != p["num_frames"]:
        notes.append(
            f"num_frames adjusted from {p['num_frames']} to {frames} (LTX needs 8k+1, {MIN_FRAMES}–{MAX_FRAMES})"
        )
    p["num_frames"] = frames
    fps = min(max(p["fps"], 12), 30)
    if fps != p["fps"]:
        notes.append(f"fps clamped from {p['fps']} to {fps}")
    p["fps"] = fps

    image = load_image(p.pop("image"))
    w, h = RESOLUTIONS[p["resolution"]]
    if image.height > image.width:  # portrait source -> portrait video
        w, h = h, w
    p["width"], p["height"] = w, h
    p["duration_s"] = round(p["num_frames"] / p["fps"], 2)
    return p, notes, image.resize((w, h))


# --------------------------------------------------------------------------- #
#                                  Handler                                    #
# --------------------------------------------------------------------------- #
BACKEND = load_backend()
READY_S = time.perf_counter() - PROCESS_START
_jobs_served = 0


def make_progress_reporter(job):
    last_sent = [0.0]

    def report(step, total):
        now = time.perf_counter()
        if step < total and now - last_sent[0] < PROGRESS_INTERVAL_S:
            return
        last_sent[0] = now
        if WORKER_ID:
            runpod.serverless.progress_update(job, {"step": step, "total_steps": total})

    return report


def handler(job):
    global _jobs_served
    t_start = time.perf_counter()
    job_id = job.get("id") or str(uuid.uuid4())
    try:
        p, notes, image = normalize_input(job.get("input"))
    except InputError as e:
        return {"error": str(e)}

    try:
        t_inf = time.perf_counter()
        frames, audio = BACKEND.generate(p, image, on_step=make_progress_reporter(job))
        inference_ms = (time.perf_counter() - t_inf) * 1000
        t_enc = time.perf_counter()
        mp4 = BACKEND.encode(frames, audio, p["fps"])
        encode_ms = (time.perf_counter() - t_enc) * 1000
    except Exception as e:  # never let one bad job kill the worker loop
        log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
        if "out of memory" in str(e).lower():
            return {"error": "GPU out of memory; try 540p or fewer frames"}
        return {"error": f"generation failed: {type(e).__name__}: {e}"}

    b64 = base64.b64encode(mp4).decode("ascii")
    if len(b64) > MAX_RESULT_MB * 2**20:
        return {
            "error": f"video is {len(b64) / 2**20:.1f} MB as base64, over the {MAX_RESULT_MB:g} MB result limit; "
            "use 540p or fewer frames"
        }

    cold_start = _jobs_served == 0
    _jobs_served += 1
    response = {
        "video": b64,
        "mime_type": "video/mp4",
        "bytes": len(mp4),
        "seed": p["seed"],
        "timings": {
            "inference_ms": round(inference_ms, 1),
            "encode_ms": round(encode_ms, 1),
            "total_ms": round((time.perf_counter() - t_start) * 1000, 1),
        },
        "worker": {
            "id": WORKER_ID,
            **BACKEND.device,
            "peak_vram_gb": BACKEND.peak_vram_gb(),
            "cold_start": cold_start,
            "model_load_ms": round(BACKEND.load_ms, 1),
            "process_ready_s": round(READY_S, 2),
            "jobs_served": _jobs_served,
        },
        "params": {k: v for k, v in p.items() if k != "prompt"} | {"model": MODEL_ID, "offload": OFFLOAD},
    }
    if notes:
        response["notes"] = notes
    return response


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
