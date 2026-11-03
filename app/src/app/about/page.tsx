import Link from "next/link";

const STEPS = [
  ["Browser", "Sends the prompt to this app's /api/generate with the access code. Never sees the Runpod API key."],
  [
    "Next.js API route",
    "Checks the access code, rate limit and daily cap, then calls Runpod /run with the server-side key. Polls /status for the browser.",
  ],
  [
    "Runpod queue",
    "Holds the job until a worker is free. If none is warm, the autoscaler starts one: pull the image (cached per host), start the container, load FLUX into GPU memory. This is delayTime.",
  ],
  [
    "Worker (handler.py)",
    "Validates input, runs FluxPipeline in BF16 on a 48 GB GPU, sends step progress, returns the image plus GPU, timings and cold-start flag. This is executionTime, the billed part.",
  ],
  ["Back to the browser", "The app records the job (no image) for the history and cost panels."],
];

export default function About() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/" className="text-sm text-accent hover:underline">
        ← Back to the demo
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">How it works</h1>
      <ol className="mt-6 space-y-4">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="card flex gap-4">
            <span className="font-mono text-subtle">{i + 1}</span>
            <div>
              <h2 className="font-medium">{title}</h2>
              <p className="mt-1 text-sm text-subtle">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <section className="card mt-6 text-sm">
        <h2 className="card-title">Reading the numbers</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-subtle">
          <li>
            <b className="text-foreground">Queue + cold start</b> is Runpod&apos;s delayTime. Warm: ~0.1 s. A worker
            woken by FlashBoot: tens of seconds. A host that has never pulled the 30 GB image: minutes.
          </li>
          <li>
            <b className="text-foreground">Execution</b> is Runpod&apos;s executionTime, what a request costs at the
            GPU&apos;s per-second price.
          </li>
          <li>
            <b className="text-foreground">Idle workers</b> are billed until the idle timeout, which buys warm starts for
            the next request.
          </li>
        </ul>
      </section>
    </main>
  );
}
