"""Video worker tests. MOCK_PIPELINE=1 swaps LTX-2.5 for a synthetic backend, so no GPU is needed."""

import base64
import importlib.util
import io
import os
from pathlib import Path

from PIL import Image

os.environ["MOCK_PIPELINE"] = "1"

_path = Path(__file__).resolve().parents[1] / "workers" / "video" / "handler.py"
_spec = importlib.util.spec_from_file_location("video_handler", _path)
handler = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(handler)


def image_b64(w=640, h=480, data_uri=True):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (120, 90, 60)).save(buf, "JPEG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}" if data_uri else b64


def run(**inp):
    inp.setdefault("image", image_b64())
    inp.setdefault("prompt", "slow push-in")
    return handler.handler({"id": "video-test", "input": inp})


def test_defaults_landscape():
    out = run()
    assert "error" not in out
    assert out["mime_type"] == "video/mp4"
    assert base64.b64decode(out["video"])[4:8] == b"ftyp"
    p = out["params"]
    assert (p["width"], p["height"]) == (960, 544)
    assert p["num_frames"] == 121 and p["fps"] == 24 and p["duration_s"] == 5.04
    assert {"inference_ms", "encode_ms", "total_ms"} == set(out["timings"])
    assert {"gpu", "cold_start", "model_load_ms", "peak_vram_gb"} <= set(out["worker"])


def test_portrait_source_gives_portrait_video():
    out = run(image=image_b64(480, 640), resolution="720p")
    assert (out["params"]["width"], out["params"]["height"]) == (704, 1280)


def test_raw_base64_image_accepted():
    assert "error" not in run(image=image_b64(data_uri=False))


def test_frames_snap_to_8k_plus_1():
    out = run(num_frames=100)
    assert out["params"]["num_frames"] == 97
    assert any("8k+1" in n for n in out["notes"])
    assert run(num_frames=1)["params"]["num_frames"] == 9
    assert run(num_frames=10_000)["params"]["num_frames"] == 241


def test_errors():
    assert "required" in handler.handler({"id": "j", "input": {"prompt": "x"}})["error"]
    assert "motion" in run(prompt="  ")["error"]
    assert "resolution" in run(resolution="4k")["error"]
    assert "base64" in run(image="not an image!")["error"]
    assert "decoded" in run(image=base64.b64encode(b"hello").decode())["error"]
    assert "https" in run(image="http://example.com/a.jpg")["error"]
    assert "seed" in run(seed=-5)["error"]


def test_result_size_guard(monkeypatch):
    monkeypatch.setattr(handler, "MAX_RESULT_MB", 0.00001)
    assert "result limit" in run()["error"]


def test_oom_is_reported_and_worker_survives(monkeypatch):
    def boom(p, image, on_step=None):
        raise RuntimeError("CUDA out of memory. Tried to allocate 20 GiB")

    monkeypatch.setattr(handler.BACKEND, "generate", boom)
    assert "540p" in run()["error"]


def test_model_path_prefers_runpod_model_store(tmp_path):
    store, cache = tmp_path / "store", tmp_path / "cache"
    model = "Lightricks/LTX-2.5-Diffusers"
    rev = store / "Lightricks" / "LTX-2.5-Diffusers" / "4791a110"
    rev.mkdir(parents=True)
    (rev / "model_index.json").write_text("{}")
    hf = cache / "models--Lightricks--LTX-2.5-Diffusers" / "snapshots" / "abc123"
    hf.mkdir(parents=True)
    (hf / "model_index.json").write_text("{}")
    assert handler.resolve_model_path(model, str(store), str(cache)) == str(rev)


def test_model_path_falls_back_to_hf_cache_layout_then_repo_id(tmp_path):
    store, cache = tmp_path / "store", tmp_path / "cache"
    model = "Lightricks/LTX-2.5-Diffusers"
    hf = cache / "models--Lightricks--LTX-2.5-Diffusers" / "snapshots" / "abc123"
    hf.mkdir(parents=True)
    (hf / "model_index.json").write_text("{}")
    assert handler.resolve_model_path(model, str(store), str(cache)) == str(hf)
    # A directory without model_index.json is not a usable snapshot.
    (store / "Other" / "Model" / "rev").mkdir(parents=True)
    assert handler.resolve_model_path("Other/Model", str(store), str(cache)) == "Other/Model"
    assert handler.resolve_model_path(model, str(store), str(cache), explicit="/x") == "/x"


def test_ltx_defaults_audio_on_and_fixed_steps():
    out = run(steps=20)
    assert out["params"]["audio"] is True and out["params"]["steps"] == 8
    assert any("steps ignored" in n for n in out["notes"])


def test_wan_keeps_aspect_ratio_and_defaults(monkeypatch):
    monkeypatch.setattr(handler, "FAMILY", "wan22")
    square = run(image=image_b64(512, 512))
    p = square["params"]
    assert (p["width"], p["height"]) == (736, 736)  # same pixel area as 960x544, square
    assert p["width"] % 32 == 0 and p["steps"] == 30 and p["audio"] is False
    landscape = run(image=image_b64(640, 480))["params"]
    assert (landscape["width"], landscape["height"]) == (832, 640)


def test_wan_steps_clamped_and_audio_request_noted(monkeypatch):
    monkeypatch.setattr(handler, "FAMILY", "wan22")
    out = run(steps=500, audio=True)
    assert out["params"]["steps"] == 50 and out["params"]["audio"] is False
    assert any("audio isn't supported" in n for n in out["notes"])
    assert any("steps clamped" in n for n in out["notes"])


def test_image_url_must_be_https_and_downloads(monkeypatch):
    out = run(image="http://example.com/a.jpg")
    assert "https" in out["error"]

    jpeg = base64.b64decode(image_b64(data_uri=False))

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(handler.urllib.request, "urlopen", lambda url, timeout: Resp(jpeg))
    out = run(image="https://example.com/a.jpg")
    assert "error" not in out
    assert out["params"]["width"] > out["params"]["height"]  # 640x480 source stays landscape


def test_image_download_failure_and_oversize(monkeypatch):
    def boom(url, timeout):
        raise OSError("connection refused")

    monkeypatch.setattr(handler.urllib.request, "urlopen", boom)
    assert "could not download" in run(image="https://example.com/a.jpg")["error"]
    monkeypatch.setattr(handler, "MAX_IMAGE_BYTES", 10)
    assert "larger than" in run()["error"]


def test_undecodable_image_is_an_input_error():
    junk = base64.b64encode(b"definitely not an image").decode()
    assert "decoded" in run(image=junk)["error"]


def test_progress_updates_are_throttled_and_end_on_last_step(monkeypatch):
    sent = []
    monkeypatch.setattr(handler, "WORKER_ID", "pod-1")
    monkeypatch.setattr(handler.runpod.serverless, "progress_update", lambda job, p: sent.append(p))
    report = handler.make_progress_reporter({"id": "j"})
    for step in range(1, 31):
        report(step, 30)
    # Steps arrive faster than the 1 s interval: the first and the last are sent.
    assert sent[0] == {"step": 1, "total_steps": 30}
    assert sent[-1] == {"step": 30, "total_steps": 30}
    assert len(sent) == 2


def test_no_progress_updates_outside_runpod(monkeypatch):
    sent = []
    monkeypatch.setattr(handler, "WORKER_ID", None)
    monkeypatch.setattr(handler.runpod.serverless, "progress_update", lambda job, p: sent.append(p))
    handler.make_progress_reporter({"id": "j"})(30, 30)
    assert sent == []


def test_result_reports_worker_and_timings():
    out = run(num_frames=9)
    assert out["mime_type"] == "video/mp4"
    assert set(out["timings"]) >= {"inference_ms", "encode_ms", "total_ms"}
    assert out["worker"]["gpu"] == "mock"
    assert base64.b64decode(out["video"])[4:8] == b"ftyp"
