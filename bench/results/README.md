# Raw benchmark results

One JSON line per job, written by `bench/bench.py run` (images stripped). Every number in
the README's results table comes from these files via `bench/bench.py report`.

- `20261103T204057Z-v0.1.0-seq-1024.jsonl`: 21 sequential 1024², 28-step jobs. Started right
  after the template moved to v0.2.0, but Runpod kept serving from the already-warm v0.1.0
  worker (template changes don't replace warm workers), so the per-job `worker` block (GPU,
  cold start) is missing and cost can't be attributed per GPU. Billing showed the Ada pool
  rate ($1.75/h) during the run. Job 0 is a FlashBoot resume (delayTime 34.7 s).
