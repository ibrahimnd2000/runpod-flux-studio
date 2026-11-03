// Plain-language definitions shown in ⓘ tooltips. One place, so the wording
// stays consistent across the Studio, the endpoint card and the library.

export const GLOSSARY = {
  prompt: "Describe the image you want: subject, setting, lighting, style. FLUX follows long, specific prompts well.",
  aspect: "Shape of the image. Bigger images take longer and cost more (time grows roughly with the pixel count).",
  steps:
    "How many refinement passes the model makes. More steps = more detail but slower. 28 is a good default; 8–12 is fine for quick drafts.",
  guidance:
    "How strictly the image follows your prompt. Around 3.5 works best for FLUX; much higher can look over-saturated.",
  seed: "The random starting point. The same prompt + seed + settings gives the same image, so lock it to make small edits reproducible.",
  variations: "How many different images (different seeds) to make for each prompt line.",
  bulk: "Each image is its own Runpod job, all sent at once. Runpod's autoscaler spreads them across GPU workers, so they run in parallel up to the endpoint's max workers.",
  coldStart:
    "The first request on a new GPU worker has to start the container and load the 33 GB model into GPU memory. Later requests on the same worker skip this.",
  queue:
    "Runpod's delayTime: how long the job waited before a GPU started it. Includes the cold start when no worker was warm.",
  execution: "Runpod's executionTime: time the GPU spent on your job. This is the part you pay for.",
  inference: "Time inside the FLUX model itself, generating the image.",
  encode: "Turning the generated pixels into a JPEG to send back.",
  network: "Time between your browser and the app/Runpod that isn't queue or GPU time: uploads, downloads and status polling.",
  cost: "Execution time × the GPU's list price per second. Idle time before a worker scales down is billed separately.",
  speedup:
    "Sum of all GPU execution times ÷ the total time the run took. 2× means two images were being generated at the same time.",
  gpuPool:
    "A group of GPU models with the same memory and price. The endpoint can run on any listed GPU, which improves availability.",
  excluded: "GPU types removed from the pool. The Blackwell slice is excluded because this image's PyTorch build can't run on it.",
  workers: "GPU machines serving this endpoint. Runpod starts them when jobs arrive and stops them when idle (min 0 = scale to zero).",
  running: "Active: executing a job, or staying warm for the idle timeout afterwards. Billed per second.",
  idle: "Stopped, but its host has the image cached, so it can resume quickly (FlashBoot) when a job arrives. Not billed.",
  initializing: "Starting up: pulling the container image or loading the model.",
  throttled: "Has the image cached but its GPU is busy with other users. Runpod uses it as soon as it frees up.",
  unhealthy: "Failed a health check and is being replaced.",
  autoscaling: "Runpod adds a worker when a job has waited longer than this, up to max workers.",
  flashboot: "Runpod keeps a stopped worker's state so it can resume in seconds instead of booting from scratch.",
  idleTimeout: "How long a warm worker waits for another job before shutting down. Longer = more warm starts, more idle cost.",
  vram: "GPU memory used at peak. FLUX.1-dev in BF16 needs about 34 GB, so it runs on 48 GB cards without offloading.",
  accessCode: "This public demo spends real GPU credits, so generating and deleting need the code you were given.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
