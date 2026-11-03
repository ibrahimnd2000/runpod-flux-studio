"""Benchmark report: percentiles, cold-start counting and cost per image."""

import importlib.util
from pathlib import Path

_path = Path(__file__).resolve().parents[1] / "bench" / "bench.py"
_spec = importlib.util.spec_from_file_location("bench", _path)
bench = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bench)


def row(i, execution_ms, cold=False, gpu="NVIDIA L40S", status="COMPLETED"):
    return {
        "label": "warm-1024",
        "i": i,
        "status": status,
        "error": None,
        "input": {"width": 1024, "height": 1024, "num_inference_steps": 28},
        "delay_ms": 600_000 if cold else 150,
        "execution_ms": execution_ms,
        "client_wall_ms": execution_ms + 4000,
        "timings": {"inference_ms": execution_ms - 500},
        "worker": {"gpu": gpu, "cold_start": cold},
    }


def test_percentiles():
    assert bench.pct([1, 2, 3, 4], 0.5) == 2.5
    assert bench.pct([10], 0.9) == 10
    assert bench.pct([], 0.5) is None


def test_report_counts_cold_and_prices_execution_time():
    rows = [row(0, 20_000, cold=True), row(1, 22_000), row(2, 24_000), row(3, 0, status="FAILED")]
    table = bench.report_rows(rows)
    line = next(line for line in table.splitlines() if line.startswith("| warm-1024"))
    assert "3/4 (1 cold)" in line
    assert "| 22.0 / " in line  # executionTime p50
    # mean execution 22 s on L40S at $1.75/h
    assert f"${22 * 1.75 / 3600:.4f}" in line


def test_every_gpu_type_in_endpoint_pools_has_a_price():
    prices = bench.yaml.safe_load((Path(bench.__file__).parent / "prices.yaml").read_text())["per_hour"]
    for gpu in ["NVIDIA L40", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA A40", "NVIDIA RTX A6000"]:
        assert gpu in prices
