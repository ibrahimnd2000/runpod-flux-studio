"""
Benchmark the FLUX.1-dev endpoint and price each request.

Every job goes through /run + /status, so the numbers are Runpod's own:
  delayTime      queue wait + cold start (image pull, container start, model load)
  executionTime  handler run time; this is what a request costs at the GPU's $/s
plus client wall time and the worker fields the handler returns (GPU, cold_start, ...).

  set -a; source .env; set +a
  python bench/bench.py run --label warm-1024 --n 20 --width 1024 --steps 28
  python bench/bench.py run --label burst-1024 --n 12 --concurrency 12
  python bench/bench.py report bench/results/*.jsonl > docs/benchmarks.md

Against the local mock server (no GPU, no credits):
  MOCK_PIPELINE=1 python workers/image/handler.py --rp_serve_api --rp_api_port 8000
  RUNPOD_API_KEY=x python bench/bench.py run --label local --n 3 --api-base http://localhost:8000

Raw results (one JSON line per job, images stripped) go to bench/results/.
"""

import argparse
import json
import os
import statistics
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import yaml

API = "https://api.runpod.ai/v2"
HERE = Path(__file__).resolve().parent
PROMPTS = [
    "A studio product photo of a ceramic coffee mug on a walnut table, soft morning light, shallow depth of field",
    "A pair of white running shoes on a concrete plinth, hard rim light, minimalist product shot",
    "A glass bottle of olive oil beside fresh rosemary on linen, overhead flat lay, natural light",
    "A leather backpack hanging on a wooden peg against a sage green wall, catalogue photo",
]
TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}
# OSError covers URLError, HTTPError and socket timeouts; a bad body is a JSONDecodeError.
NETWORK_ERRORS = (OSError, json.JSONDecodeError)


def call(method, url, key, body=None):
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def endpoint_url(args, endpoint):
    base = args.api_base.rstrip("/")
    return f"{base}/{endpoint}" if endpoint else base


def is_runpod(args) -> bool:
    return args.api_base.rstrip("/") == API


def run_one(i, args, key, endpoint):
    job_input = {
        "prompt": PROMPTS[i % len(PROMPTS)],
        "width": args.width,
        "height": args.height or args.width,
        "num_inference_steps": args.steps,
        "seed": 1000 + i,
        "image_format": args.image_format,
    }
    started_at = time.time()
    t0 = time.monotonic()
    url = endpoint_url(args, endpoint)
    try:
        job = call("POST", f"{url}/run", key, {"input": job_input})
    except NETWORK_ERRORS as e:  # nothing was queued; record it and move on
        job, status = {"id": None}, {"status": "CLIENT_ERROR", "error": f"submit failed: {e}"}
    else:
        # The SDK's local API server only accepts POST on /status; Runpod accepts GET.
        status_method = "GET" if is_runpod(args) else "POST"
        status = job
    while status.get("status") not in TERMINAL | {"CLIENT_ERROR"}:
        if time.monotonic() - t0 > args.timeout:
            status = {**status, "status": "CLIENT_TIMEOUT"}
            break
        time.sleep(args.poll)
        try:
            status = call(status_method, f"{url}/status/{job['id']}", key)
        except NETWORK_ERRORS as e:  # transient: keep polling
            print(f"  job {i}: poll error {e}", file=sys.stderr)
    wall = time.monotonic() - t0
    out = status.get("output") if isinstance(status.get("output"), dict) else {}
    row = {
        "label": args.label,
        "i": i,
        "job_id": job["id"],
        "submitted_at": datetime.fromtimestamp(started_at, UTC).isoformat(),
        "status": status.get("status"),
        "error": status.get("error") or out.get("error"),
        "input": job_input,
        "delay_ms": status.get("delayTime"),
        "execution_ms": status.get("executionTime"),
        "client_wall_ms": round(wall * 1000),
        "timings": out.get("timings"),
        "worker": out.get("worker"),
        "image_bytes_b64": sum(len(s) for s in out.get("images", [])),
    }
    w = row["worker"] or {}
    print(
        f"  job {i:>2} {row['status']:<9} delay {row['delay_ms'] or 0:>8} ms  exec {row['execution_ms'] or 0:>6} ms"
        f"  wall {row['client_wall_ms']:>7} ms  gpu {w.get('gpu', '?')}  cold {w.get('cold_start')}",
        file=sys.stderr,
    )
    return row


def cmd_run(args):
    key = os.environ.get("RUNPOD_API_KEY")
    local = not is_runpod(args)
    endpoint = args.endpoint or ("" if local else os.environ.get("RUNPOD_IMAGE_ENDPOINT_ID"))
    if not key or (endpoint is None and not local):
        sys.exit("set RUNPOD_API_KEY and RUNPOD_IMAGE_ENDPOINT_ID (or pass --endpoint)")

    out_dir = HERE / "results"
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"{stamp}-{args.label}.jsonl"
    print(f"{args.label}: {args.n} jobs, concurrency {args.concurrency} -> {path}", file=sys.stderr)

    # Each row is written as soon as its job ends, so an interrupted run keeps what it paid for.
    lock = threading.Lock()
    with path.open("w") as f:

        def run_and_write(i):
            row = run_one(i, args, key, endpoint)
            with lock:
                f.write(json.dumps(row) + "\n")
                f.flush()

        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            list(pool.map(run_and_write, range(args.n)))
    print(report([path]))


# --------------------------------------------------------------------------- #
#                                   Report                                    #
# --------------------------------------------------------------------------- #
def pct(values, q):
    if not values:
        return None
    values = sorted(values)
    k = (len(values) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def fmt_s(ms):
    return "–" if ms is None else f"{ms / 1000:.1f}"


def load_rows(paths):
    return [json.loads(line) for p in paths for line in Path(p).read_text().splitlines() if line.strip()]


def report(paths):
    return report_rows(load_rows(paths))


def report_rows(rows):
    prices = yaml.safe_load((HERE / "prices.yaml").read_text())
    per_hour = prices["per_hour"]

    groups = {}
    for r in rows:
        groups.setdefault(r["label"], []).append(r)

    lines = [
        "| Scenario | Size, steps | GPU | Jobs (ok/cold) | delayTime p50 / max (s) | executionTime p50 / p90 (s)"
        " | Inference p50 (s) | Client wall p50 (s) | $ / image |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for label, rs in groups.items():
        ok = [r for r in rs if r["status"] == "COMPLETED" and not r["error"]]
        cold = sum(1 for r in ok if (r["worker"] or {}).get("cold_start"))
        gpus = sorted({(r["worker"] or {}).get("gpu", "?") for r in ok})
        delay = [r["delay_ms"] for r in ok if r["delay_ms"] is not None]
        execs = [r["execution_ms"] for r in ok if r["execution_ms"] is not None]
        inf = [r["timings"]["inference_ms"] for r in ok if r["timings"]]
        wall = [r["client_wall_ms"] for r in ok]
        # Cost per request = execution seconds x the serving GPU's list $/s.
        costs = [
            r["execution_ms"] / 1000 * per_hour[r["worker"]["gpu"]] / 3600
            for r in ok
            if r["execution_ms"] is not None and (r["worker"] or {}).get("gpu") in per_hour
        ]
        inp = rs[0]["input"]
        lines.append(
            f"| {label} | {inp['width']}×{inp['height']}, {inp['num_inference_steps']} | {', '.join(gpus)}"
            f" | {len(ok)}/{len(rs)} ({cold} cold) | {fmt_s(pct(delay, 0.5))} / {fmt_s(max(delay, default=None))}"
            f" | {fmt_s(pct(execs, 0.5))} / {fmt_s(pct(execs, 0.9))} | {fmt_s(pct(inf, 0.5))}"
            f" | {fmt_s(pct(wall, 0.5))} | {'–' if not costs else f'${statistics.mean(costs):.4f}'} |"
        )
    lines.append("")
    lines.append(
        f"Cost = executionTime × list price ({prices['source']}, checked {prices['checked']}). "
        "Excludes idle-timeout time, which is billed while a warm worker waits for the next job."
    )
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="send jobs and record timings")
    r.add_argument("--label", required=True, help="scenario name, e.g. warm-1024")
    r.add_argument("--n", type=int, default=20)
    r.add_argument("--concurrency", type=int, default=1, help="jobs in flight at once (1 = sequential)")
    r.add_argument("--width", type=int, default=1024)
    r.add_argument("--height", type=int, default=None, help="defaults to --width")
    r.add_argument("--steps", type=int, default=28)
    r.add_argument("--image-format", default="png", choices=["png", "jpeg"])
    r.add_argument("--poll", type=float, default=1.0, help="seconds between /status polls")
    r.add_argument("--timeout", type=float, default=1800, help="give up on a job after this many seconds")
    r.add_argument("--endpoint", help="defaults to $RUNPOD_IMAGE_ENDPOINT_ID")
    r.add_argument("--api-base", default=API, help="e.g. http://localhost:8000 for the SDK's local API server")
    rep = sub.add_parser("report", help="markdown table from saved results")
    rep.add_argument("paths", nargs="+")
    args = ap.parse_args()
    if args.cmd == "run":
        cmd_run(args)
    else:
        print(report(args.paths))


if __name__ == "__main__":
    main()
