"""
LoRA fine-tuning for FLUX.1-dev, run as a job on the same worker image.

A small training loop instead of a framework: captions and images are encoded
once (T5 + CLIP, VAE), the text encoders and VAE are parked on the CPU (and
restored afterwards, so the worker can keep generating), and only rank-r
adapters on the transformer's attention projections are trained with the
flow-matching objective FLUX was trained with. The adapter is saved in the
diffusers/PEFT format that FluxPipeline.load_lora_weights reads, then PUT to
the app that asked for it (the job carries a one-time upload token).

Input (job["input"], task "train_lora"):
  images        [{url, caption}], 4-40 https URLs (JPEG/PNG/WebP), one caption each
  steps         optimizer steps, default 800 (100-3000)
  rank          LoRA rank, default 16 (4-64)
  learning_rate default 1e-4
  resolution    training side in px, default 512 (512, 768 or 1024)
  upload_url    https URL the finished .safetensors is PUT to
  upload_token  sent as X-Upload-Token with that PUT
  seed          optional, 0 to 2**32-1; reproduces noise and sample order
"""

import hashlib
import io
import logging
import math
import os
import random
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

log = logging.getLogger("flux-worker")

MIN_IMAGES, MAX_IMAGES = 4, 40
MAX_IMAGE_BYTES = 20 * 2**20
MAX_CAPTION_CHARS = 600
RESOLUTIONS = (512, 768, 1024)
TARGET_MODULES = ["to_k", "to_q", "to_v", "to_out.0"]
PROGRESS_EVERY_STEPS = 10
MAX_SEED = 2**32 - 1
# Guidance embedding fed to FLUX.1-dev (guidance-distilled) during training. 1.0 is a
# common choice for FLUX LoRAs; diffusers' DreamBooth script defaults to 3.5. The
# measured run in the README used 1.0 and generates fine at the usual 3.5.
TRAIN_GUIDANCE = 1.0


class TrainInputError(ValueError):
    """Bad training request; message is returned verbatim."""


class UploadError(RuntimeError):
    """Training finished but the adapter couldn't be delivered to upload_url."""


def is_https_url(url) -> bool:
    """An absolute https URL (handler.py uses this for LoRA URLs too)."""
    if not isinstance(url, str):
        return False
    parts = urlparse(url)
    return parts.scheme == "https" and bool(parts.netloc)


def _https(url, what):
    if not is_https_url(url):
        raise TrainInputError(f"{what} must be an https URL")
    return url


def normalize_train_input(raw) -> dict:
    if not isinstance(raw, dict):
        raise TrainInputError("input must be a JSON object")
    images = raw.get("images")
    if not isinstance(images, list) or not MIN_IMAGES <= len(images) <= MAX_IMAGES:
        raise TrainInputError(f"images must be a list of {MIN_IMAGES}-{MAX_IMAGES} items")
    clean = []
    for i, item in enumerate(images):
        if not isinstance(item, dict):
            raise TrainInputError(f"images[{i}] must be an object with url and caption")
        caption = str(item.get("caption") or "").strip()
        if not caption:
            raise TrainInputError(f"images[{i}].caption is empty")
        clean.append({"url": _https(item.get("url"), f"images[{i}].url"), "caption": caption[:MAX_CAPTION_CHARS]})

    def num(name, default, lo, hi, cast):
        v = raw.get(name, default)
        try:
            v = cast(v)
        except (TypeError, ValueError):
            raise TrainInputError(f"{name} must be a number") from None
        if not lo <= v <= hi:
            raise TrainInputError(f"{name} must be between {lo} and {hi}")
        return v

    resolution = raw.get("resolution", 512)
    if isinstance(resolution, bool) or resolution not in RESOLUTIONS:
        raise TrainInputError(f"resolution must be one of {RESOLUTIONS}")
    token = raw.get("upload_token")
    if not isinstance(token, str) or len(token) < 16:
        raise TrainInputError("upload_token must be a string of at least 16 characters")
    seed = raw.get("seed")
    if seed is None:
        seed = random.randint(0, MAX_SEED)
    elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= MAX_SEED:
        raise TrainInputError(f"seed must be an integer between 0 and {MAX_SEED}")
    return {
        "images": clean,
        "steps": num("steps", 800, 100, 3000, int),
        "rank": num("rank", 16, 4, 64, int),
        "learning_rate": num("learning_rate", 1e-4, 1e-6, 1e-3, float),
        "resolution": int(resolution),
        "upload_url": _https(raw.get("upload_url"), "upload_url"),
        "upload_token": token,
        "seed": seed,
    }


def fetch(url: str, limit: int = MAX_IMAGE_BYTES) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "flux-lora-trainer"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read(limit + 1)
    if len(data) > limit:
        raise TrainInputError(f"{url} is larger than {limit // 2**20} MB")
    return data


def upload(url: str, token: str, data: bytes) -> None:
    req = urllib.request.Request(
        url,
        data=data,
        method="PUT",
        headers={
            "X-Upload-Token": token,
            "Content-Type": "application/octet-stream",
            "User-Agent": "flux-lora-trainer",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            if res.status >= 300:
                raise UploadError(f"HTTP {res.status}")
    except urllib.error.HTTPError as e:
        raise UploadError(f"HTTP {e.code}") from None
    except OSError as e:  # URLError, timeouts, connection resets
        raise UploadError(type(e).__name__) from None


def center_crop(image, side: int):
    from PIL import Image

    image = image.convert("RGB")
    w, h = image.size
    s = min(w, h)
    image = image.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    return image.resize((side, side), Image.Resampling.LANCZOS)


def load_images(items, side):
    from PIL import Image, UnidentifiedImageError

    out = []
    for i, item in enumerate(items):
        try:
            data = fetch(item["url"])
            out.append(center_crop(Image.open(io.BytesIO(data)), side))
        except TrainInputError:
            raise
        except UnidentifiedImageError:
            raise TrainInputError(f"images[{i}] is not a readable image") from None
        except Exception as e:
            raise TrainInputError(f"images[{i}] could not be downloaded: {type(e).__name__}") from None
    return out


def flux_time_shift(sigma, seq_len):
    """FLUX.1-dev's resolution-dependent schedule shift (calculate_shift in FluxPipeline)."""
    m = (1.15 - 0.5) / (4096 - 256)
    mu = 0.5 + m * (seq_len - 256)
    return math.exp(mu) / (math.exp(mu) + (1 / sigma - 1))


class FluxTrainer:
    """Trains on the worker's already-loaded pipeline (handler.FluxBackend) and
    leaves it as it found it, so the same worker can keep generating images."""

    def __init__(self, pipe):
        import torch

        self.torch = torch
        self.pipe = pipe

    def train(self, p: dict, images, on_progress) -> dict:
        torch = self.torch
        import numpy as np
        from diffusers import FluxPipeline
        from diffusers.training_utils import cast_training_params
        from peft import LoraConfig
        from peft.utils import get_peft_model_state_dict

        pipe, dev = self.pipe, "cuda"
        torch.manual_seed(p["seed"])
        rng = random.Random(p["seed"])  # sample order, so a seed reproduces the run
        torch.cuda.reset_peak_memory_stats()
        t_enc = time.perf_counter()

        # 1. Encode every caption and image once, then park the encoders on the CPU
        #    so the transformer's activations have the GPU to themselves.
        vae = pipe.vae
        scale_factor = 2 ** (len(vae.config.block_out_channels) - 1)
        samples = []
        with torch.no_grad():
            for image, item in zip(images, p["images"], strict=True):
                embeds, pooled, text_ids = pipe.encode_prompt(
                    prompt=item["caption"], prompt_2=item["caption"], device=dev, max_sequence_length=512
                )
                pixels = torch.from_numpy(np.asarray(image, dtype=np.float32)).permute(2, 0, 1)[None]
                pixels = (pixels / 127.5 - 1).to(dev, torch.bfloat16)
                lat = vae.encode(pixels).latent_dist.sample()
                lat = (lat - vae.config.shift_factor) * vae.config.scaling_factor
                samples.append((lat, embeds, pooled, text_ids))
        encode_ms = (time.perf_counter() - t_enc) * 1000

        transformer = pipe.transformer
        adapter_added = False
        opt = params = None
        losses = []
        # Everything from here on changes the shared pipeline, so it all sits inside the
        # try: whatever fails (an OOM while adding the adapter, say), the finally puts the
        # worker back the way generation expects it.
        try:
            pipe.text_encoder.to("cpu")
            pipe.text_encoder_2.to("cpu")
            vae.to("cpu")
            torch.cuda.empty_cache()

            # 2. Rank-r adapters on the attention projections; base weights frozen.
            transformer.requires_grad_(False)
            transformer.add_adapter(
                LoraConfig(
                    r=p["rank"], lora_alpha=p["rank"], init_lora_weights="gaussian", target_modules=TARGET_MODULES
                )
            )
            adapter_added = True
            cast_training_params(transformer, dtype=torch.float32)
            transformer.enable_gradient_checkpointing()
            transformer.train()
            params = [q for q in transformer.parameters() if q.requires_grad]
            opt = torch.optim.AdamW(params, lr=p["learning_rate"], weight_decay=1e-4)

            _, c, h, w = samples[0][0].shape
            seq_len = (h // 2) * (w // 2)
            img_ids = FluxPipeline._prepare_latent_image_ids(1, h // 2, w // 2, dev, torch.bfloat16)
            guidance = torch.full([1], TRAIN_GUIDANCE, device=dev)

            # 3. Flow matching: x_t = (1 - s) x0 + s noise, predict (noise - x0).
            t_train = time.perf_counter()
            for step in range(1, p["steps"] + 1):
                lat, embeds, pooled, text_ids = samples[rng.randrange(len(samples))]
                noise = torch.randn_like(lat)
                u = torch.sigmoid(torch.randn(1)).item()  # logit-normal(0, 1)
                sigma = flux_time_shift(min(max(u, 1e-4), 1 - 1e-4), seq_len)
                noisy = (1 - sigma) * lat + sigma * noise
                packed = FluxPipeline._pack_latents(noisy, 1, c, h, w)
                with torch.autocast("cuda", dtype=torch.bfloat16):
                    pred = transformer(
                        hidden_states=packed,
                        timestep=torch.full([1], sigma, device=dev),
                        guidance=guidance,
                        pooled_projections=pooled,
                        encoder_hidden_states=embeds,
                        txt_ids=text_ids,
                        img_ids=img_ids,
                        return_dict=False,
                    )[0]
                pred = FluxPipeline._unpack_latents(pred, h * scale_factor, w * scale_factor, scale_factor)
                loss = torch.nn.functional.mse_loss(pred.float(), (noise - lat).float())
                loss.backward()
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad(set_to_none=True)
                losses.append(loss.item())
                if step % PROGRESS_EVERY_STEPS == 0 or step == p["steps"]:
                    recent = losses[-PROGRESS_EVERY_STEPS:]
                    on_progress(step, p["steps"], sum(recent) / len(recent))
            train_ms = (time.perf_counter() - t_train) * 1000

            # 4. Save (bf16 halves the file) in the format load_lora_weights reads.
            state = {
                k: v.detach().to(torch.bfloat16).contiguous() for k, v in get_peft_model_state_dict(transformer).items()
            }
            with tempfile.TemporaryDirectory() as d:
                FluxPipeline.save_lora_weights(d, transformer_lora_layers=state)
                with open(os.path.join(d, "pytorch_lora_weights.safetensors"), "rb") as f:
                    data = f.read()
        finally:
            # Leave the base model as inference expects it: no adapter, all on the GPU.
            transformer.eval()
            transformer.disable_gradient_checkpointing()
            if adapter_added:
                transformer.delete_adapters("default")
            transformer.requires_grad_(False)
            del opt, params
            torch.cuda.empty_cache()
            pipe.text_encoder.to(dev)
            pipe.text_encoder_2.to(dev)
            vae.to(dev)
        tail = losses[-50:]
        return {
            "data": data,
            "encode_ms": encode_ms,
            "train_ms": train_ms,
            "final_loss": sum(tail) / len(tail),
            "peak_vram_gb": round(torch.cuda.max_memory_allocated() / 2**30, 1),
        }


class MockTrainer:
    """No GPU: walks the steps and returns a small fake adapter file."""

    def train(self, p: dict, images, on_progress) -> dict:
        for step in range(PROGRESS_EVERY_STEPS, p["steps"] + 1, PROGRESS_EVERY_STEPS):
            on_progress(step, p["steps"], 0.5 - 0.3 * step / p["steps"])
        data = b"MOCK-LORA" + hashlib.sha256(repr(p["images"]).encode()).digest()
        return {"data": data, "encode_ms": 0.0, "train_ms": 0.0, "final_loss": 0.2, "peak_vram_gb": 0.0}


def run_training(trainer, raw, on_progress) -> dict:
    """Validate, download, train, upload. Returns the job result (never the weights)."""
    p = normalize_train_input(raw)
    t0 = time.perf_counter()
    images = load_images(p["images"], p["resolution"])
    download_ms = (time.perf_counter() - t0) * 1000
    result = trainer.train(p, images, on_progress)
    data = result.pop("data")
    t_up = time.perf_counter()
    upload(p["upload_url"], p["upload_token"], data)
    return {
        "lora": {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "rank": p["rank"],
            "target_modules": TARGET_MODULES,
        },
        "params": {k: p[k] for k in ("steps", "rank", "learning_rate", "resolution", "seed")}
        | {"images": len(p["images"])},
        "final_loss": round(result["final_loss"], 4),
        "timings": {
            "download_ms": round(download_ms, 1),
            "encode_ms": round(result["encode_ms"], 1),
            "train_ms": round(result["train_ms"], 1),
            "upload_ms": round((time.perf_counter() - t_up) * 1000, 1),
        },
        "peak_vram_gb": result["peak_vram_gb"],
    }
