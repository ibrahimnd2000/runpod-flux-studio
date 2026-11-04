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
  animate:
    "Turns this image into a short clip on a separate video GPU endpoint. The image is the first frame; your prompt describes the motion.",
  videoModel:
    "Wan 2.2 (5B) runs on common 48 GB GPUs, so it usually starts quickly, but makes silent clips. LTX-2.5 (22B) looks better and adds sound, but needs scarcer 80 GB GPUs.",
  motionPrompt:
    "Describe what moves and how the camera behaves, not what's in the picture: 'slow push-in, steam rising, soft light flicker'.",
  duration: "Length of the clip at 24 fps. 2 s is quicker and cheaper for drafts; 5 s is the usual social-clip length.",
  videoResolution: "540p is faster and smaller; 720p looks sharper but takes longer and makes a bigger file.",
  audio: "LTX-2.5 generates a matching soundtrack (ambience, effects) together with the video.",
  videoColdStart:
    "Video models are big (Wan 2.2: 34 GB, LTX-2.5: 72 GB). A worker that isn't warm has to load the model first, which can take minutes. Later clips on the same worker start right away.",
  pipeline:
    "A fixed recipe of steps. Each step starts as soon as the steps it reads from are done, so independent branches run at the same time. Same shape every run, so cost is predictable.",
  fanout: "One step turns a list into one GPU job per item, all sent at once, so they render in parallel on separate workers.",
  stepRef: "Use {{input.key}} for an input, {{steps.id}} for an earlier step's output, {{steps.id.prompt}} for the prompt of its image, and {{item}} inside a fan-out step.",
  agent:
    "An LLM that decides what to do: it plans, calls tools (which start real GPU jobs), reads the results and repeats until it delivers. Every step is shown in the trace.",
  toolCall: "The model asks the app to run a function, here generate_images, animate_image and so on. The app runs it, checks the budget, and sends the result back.",
  persona: "Extra instructions in the system prompt. Same model, different behaviour: frugal reuses and drafts, perfectionist explores and refines.",
  budget:
    "Hard limits for one run: dollars (GPU + LLM tokens), images, clips and turns. A tool call that would exceed them is refused, and the agent has to adapt.",
  dryRun: "Runs the whole flow, including the LLM, but GPU tools return placeholder images priced at the measured averages. No GPU is used.",
  llmCost:
    "Claude: tokens × Anthropic's list price. Runpod vLLM: GPU-seconds × the GPU's price, an estimate because the worker bills time, not tokens.",
  judge: "Claude Opus 5.5 looks at both deliveries (the actual images) plus what each agent spent, and scores brief fit, quality and efficiency.",
  elo: "Chess-style rating: beating a higher-rated contestant gains more points. Everyone starts at 1000. Your vote overrides the judge.",
  lora: "Low-rank adaptation: small trainable matrices added to FLUX's attention layers (about 1% of its size). Training them on a few images teaches a style or subject without changing the base model.",
  trigger: "A made-up word every training caption starts with. Put it in a prompt to call up what the LoRA learned; leave it out and the model mostly behaves as before.",
  loraScale: "How strongly the LoRA is applied: 1 is as trained, lower blends back toward plain FLUX, above 1 exaggerates it.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
