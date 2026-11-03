import base64
import io
import os
import sys

os.environ["MOCK_PIPELINE"] = "1"
os.environ.pop("BUCKET_ENDPOINT_URL", None)
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from PIL import Image  # noqa: E402

import handler  # noqa: E402


def run(**inp):
    return handler.handler({"id": "test-job", "input": inp})


def decode(b64):
    return Image.open(io.BytesIO(base64.b64decode(b64)))


def test_defaults():
    out = run(prompt="a red fox")
    assert "error" not in out
    assert len(out["images"]) == 1
    assert decode(out["images"][0]).size == (1024, 1024)
    p = out["params"]
    assert p["num_inference_steps"] == 28 and p["guidance_scale"] == 3.5
    assert isinstance(out["seed"], int)
    assert set(out["timings"]) == {"inference_ms", "total_ms"}


def test_seed_is_reproducible():
    a = run(prompt="x", width=256, height=256, seed=7)
    b = run(prompt="x", width=256, height=256, seed=7)
    assert a["seed"] == 7 and a["images"] == b["images"]


def test_clamping_and_rounding():
    out = run(prompt="x", width=5000, height=300, num_inference_steps=99, num_images=10)
    assert out["params"]["width"] == 1536
    assert out["params"]["height"] == 304
    assert out["params"]["num_inference_steps"] == 50
    assert len(out["images"]) == 4
    assert len(out["notes"]) == 4  # width clamp, height round, steps, num_images


def test_guidance_accepts_int():
    assert run(prompt="x", width=256, height=256, guidance_scale=4)["params"]["guidance_scale"] == 4.0


def test_jpeg():
    out = run(prompt="x", width=256, height=256, image_format="jpeg")
    assert decode(out["images"][0]).format == "JPEG"


def test_errors():
    assert "required" in run()["error"]
    assert "non-empty" in run(prompt="   ")["error"]
    assert "max is" in run(prompt="a" * 1001)["error"]
    assert "should be" in run(prompt="x", width="big")["error"]
    assert "not a valid input" in run(prompt="x", foo=1)["error"]
    assert "negative_prompt" in run(prompt="x", negative_prompt="blurry")["error"]
    assert "bucket" in run(prompt="x", output="url")["error"]
    assert "seed" in run(prompt="x", seed=-1)["error"]
    assert "JSON object" in handler.handler({"id": "j", "input": "hi"})["error"]


def test_generation_failure_returns_error(monkeypatch):
    def boom(p):
        raise RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")

    monkeypatch.setattr(handler.BACKEND, "generate", boom)
    assert "out of memory" in run(prompt="x")["error"]
