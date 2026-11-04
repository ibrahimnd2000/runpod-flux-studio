"""LoRA training jobs and LoRA use at generation time, with MOCK_PIPELINE=1 (no GPU, no network)."""

import hashlib
import importlib.util
import io
import math
import os
from pathlib import Path

import pytest
from PIL import Image

os.environ["MOCK_PIPELINE"] = "1"
os.environ.pop("BUCKET_ENDPOINT_URL", None)

_dir = Path(__file__).resolve().parents[1] / "workers" / "image"
_spec = importlib.util.spec_from_file_location("image_handler_lora", _dir / "handler.py")
handler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(handler)
lora_train = handler.lora_train


def png(color=(200, 80, 40), size=(640, 480)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def train_input(**over):
    base = {
        "task": "train_lora",
        "images": [{"url": f"https://app.test/api/media/img{i}", "caption": f"zxq style, photo {i}"} for i in range(5)],
        "steps": 100,
        "upload_url": "https://app.test/api/loras/lora1/file",
        "upload_token": "t" * 32,
    }
    return base | over


@pytest.fixture
def network(monkeypatch):
    """Fake downloads and capture the adapter upload."""
    sent = {}
    monkeypatch.setattr(lora_train, "fetch", lambda url, limit=0: png())
    monkeypatch.setattr(lora_train, "upload", lambda url, token, data: sent.update(url=url, token=token, data=data))
    return sent


def test_training_job_uploads_the_adapter_and_reports_loss(network, monkeypatch):
    updates = []
    monkeypatch.setattr(handler, "WORKER_ID", "w1")
    monkeypatch.setattr(handler.runpod.serverless, "progress_update", lambda job, data: updates.append(data))
    monkeypatch.setattr(handler, "PROGRESS_INTERVAL_S", 0)

    out = handler.handler({"id": "train-1", "input": train_input()})
    assert "error" not in out, out
    assert network["url"] == "https://app.test/api/loras/lora1/file" and network["token"] == "t" * 32
    assert out["lora"]["bytes"] == len(network["data"])
    assert out["lora"]["sha256"] == hashlib.sha256(network["data"]).hexdigest()
    params = out["params"]
    assert params == {
        "steps": 100,
        "rank": 16,
        "learning_rate": 1e-4,
        "resolution": 512,
        "seed": params["seed"],
        "images": 5,
    }
    assert set(out["timings"]) == {"download_ms", "encode_ms", "train_ms", "upload_ms", "total_ms"}
    assert "worker" in out and "data" not in out  # weights go to the app, never into the job result
    assert updates[-1] == {"step": 100, "total_steps": 100, "loss": pytest.approx(0.2)}
    assert all(u["step"] <= 100 for u in updates)


@pytest.mark.parametrize(
    "over, message",
    [
        ({"images": [{"url": "https://a/x", "caption": "c"}] * 3}, "4-40 items"),
        ({"images": [{"url": "http://a/x", "caption": "c"}] * 4}, "https URL"),
        ({"images": [{"url": "https://a/x", "caption": " "}] * 4}, "caption is empty"),
        ({"resolution": 640}, "resolution must be one of"),
        ({"steps": 50}, "steps must be between"),
        ({"rank": "big"}, "rank must be a number"),
        ({"upload_token": "short"}, "upload_token"),
        ({"upload_url": "ftp://x"}, "upload_url must be an https URL"),
    ],
)
def test_training_input_errors(network, over, message):
    out = handler.handler({"id": "train-bad", "input": train_input(**over)})
    assert message in out["error"]
    assert "data" not in network  # nothing uploaded


def test_unreadable_training_image(monkeypatch, network):
    monkeypatch.setattr(lora_train, "fetch", lambda url, limit=0: b"not an image")
    assert "not a readable image" in handler.handler({"input": train_input()})["error"]


def test_images_are_center_cropped_to_the_training_side():
    img = lora_train.center_crop(Image.open(io.BytesIO(png(size=(900, 300)))), 512)
    assert img.size == (512, 512) and img.mode == "RGB"


def test_flux_time_shift_matches_the_pipeline_schedule():
    # mu = 0.5 at 256 tokens and 1.15 at 4096 (FluxPipeline.calculate_shift); shift pushes sigma up.
    assert lora_train.flux_time_shift(0.5, 256) == pytest.approx(math.exp(0.5) / (math.exp(0.5) + 1))
    assert lora_train.flux_time_shift(0.5, 4096) == pytest.approx(math.exp(1.15) / (math.exp(1.15) + 1))
    for s in (0.01, 0.3, 0.9):
        assert s < lora_train.flux_time_shift(s, 1024) < 1


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_generate_with_a_lora_downloads_it_once(monkeypatch, tmp_path):
    calls = []

    def urlopen(req, timeout=0):
        calls.append(req.full_url)
        return FakeResponse(b"SAFETENSORS")

    monkeypatch.setattr(handler, "LORA_DIR", str(tmp_path))
    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)
    lora = {"id": "lora_abc", "url": "https://app.test/api/loras/lora_abc/file", "scale": 0.8}
    for _ in range(2):
        out = handler.handler({"input": {"prompt": "zxq style, a cat", "width": 256, "height": 256, "lora": lora}})
        assert "error" not in out, out
        assert out["params"]["lora"] == {"id": "lora_abc", "scale": 0.8}
    assert calls == ["https://app.test/api/loras/lora_abc/file"]
    assert (tmp_path / "lora_abc.safetensors").read_bytes() == b"SAFETENSORS"


@pytest.mark.parametrize(
    "lora, message",
    [
        ({"id": "x", "url": "http://a/x"}, "lora.url must be an https URL"),
        ({"id": "../etc", "url": "https://a/x"}, "lora.id"),
        ({"id": "x", "url": "https://a/x", "scale": 3}, "lora.scale must be between 0 and 2"),
        ({"id": "x", "url": "https://a/x", "scale": "lots"}, "lora.scale must be a number"),
    ],
)
def test_lora_input_errors(lora, message):
    out = handler.handler({"input": {"prompt": "a cat", "lora": lora}})
    assert message in out["error"]


def test_lora_download_failure_is_a_clear_error(monkeypatch, tmp_path):
    def urlopen(req, timeout=0):
        raise OSError("boom")

    monkeypatch.setattr(handler, "LORA_DIR", str(tmp_path))
    monkeypatch.setattr(handler.urllib.request, "urlopen", urlopen)
    out = handler.handler(
        {"input": {"prompt": "a cat", "width": 256, "height": 256, "lora": {"id": "gone", "url": "https://a/x"}}}
    )
    assert out["error"] == "could not download the LoRA: OSError"
