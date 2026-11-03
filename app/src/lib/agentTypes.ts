// Shapes for the orchestration features (pipelines, agents, battles), shared by
// the API routes and the browser. Nothing secret lives here.

/** Who drives an agent: Claude (Anthropic API), an open model on a Runpod vLLM endpoint, or a fixed script. */
export type ProviderId = "claude" | "runpod" | "scripted";

/** System-prompt flavours, so two agents on the same model can still differ. */
export type PersonaId = "balanced" | "frugal" | "perfectionist";

export interface ModelOption {
  provider: ProviderId;
  model: string;
  label: string;
  /** Can look at images (view_image tool, visual judging). */
  vision: boolean;
  /** Token cost is an estimate (GPU-seconds × price), not a metered bill. */
  estimatedCost: boolean;
}

export interface Contestant {
  provider: ProviderId;
  model: string;
  persona: PersonaId;
}

export interface Budget {
  maxUsd: number; // GPU + LLM spend for the whole run
  maxImages: number;
  maxVideos: number;
  maxTurns: number;
}

export interface Spend {
  gpuUsd: number;
  llmUsd: number;
  /** Part of llmUsd that is estimated (vLLM GPU-seconds) rather than metered (Claude tokens). */
  llmEstimatedUsd: number;
  images: number;
  videos: number;
  toolCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export type StepState = "waiting" | "running" | "done" | "failed" | "skipped";

export type RunEvent = { seq: number; t: number } & (
  | { type: "status"; text: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      ok: boolean;
      summary: string;
      mediaIds?: string[];
      ms: number;
      costUsd?: number;
    }
  | { type: "llm"; model: string; inputTokens: number; outputTokens: number; ms: number; costUsd: number; estimated: boolean }
  | { type: "step"; stepId: string; state: StepState; summary?: string; mediaIds?: string[]; ms?: number; costUsd?: number }
  | { type: "error"; text: string }
);

/** Distributive Omit, so each RunEvent variant keeps its own fields. */
export type NewRunEvent = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "seq" | "t"> : never) : never;

export type RunStatus = "running" | "done" | "failed" | "stopped";

export interface RunResult {
  text: string;
  mediaIds: string[];
}

export interface RunView {
  id: string;
  kind: "agent" | "pipeline";
  status: RunStatus;
  createdAt: number;
  finishedAt?: number;
  title: string;
  brief: string;
  contestant?: Contestant;
  pipeline?: PipelineSpec;
  budget: Budget;
  spend: Spend;
  events: RunEvent[];
  result?: RunResult;
  battleId?: string;
  error?: string;
  /** Tools and budget ran against placeholder media, not the GPU endpoints. */
  mock: boolean;
}

export type RunSummary = Omit<RunView, "events" | "pipeline">;

// --------------------------------------------------------------------------- //
//                                  Pipelines                                  //
// --------------------------------------------------------------------------- //
export type StepType = "llm" | "image" | "images" | "pick" | "animate";

export interface PipelineStep {
  id: string; // a-z0-9_, referenced as {{steps.<id>}}
  type: StepType;
  title: string;
  /** llm: the instruction; image: the prompt; animate: the motion. Supports {{input.x}} / {{steps.y}}. */
  prompt?: string;
  /** llm: return a JSON list of `count` strings (feeds an `images` step). */
  list?: boolean;
  count?: number;
  /** images: step whose list feeds the prompts; pick/animate: step whose image(s) to use. */
  from?: string;
  width?: number;
  height?: number;
  /** animate: clip length. */
  seconds?: 2 | 3 | 5;
}

export interface PipelineInput {
  key: string;
  label: string;
  placeholder?: string;
  default?: string;
}

export interface PipelineSpec {
  id: string;
  name: string;
  description: string;
  inputs: PipelineInput[];
  steps: PipelineStep[];
  /** Model for llm / pick steps. */
  llm: Pick<Contestant, "provider" | "model">;
}

/** What a step produces; later steps read it through {{steps.<id>}}. */
export interface StepOutput {
  text?: string;
  list?: string[];
  mediaIds?: string[];
  /** The prompts behind mediaIds, same order. */
  prompts?: string[];
  reason?: string;
}

// --------------------------------------------------------------------------- //
//                                 Battleground                                //
// --------------------------------------------------------------------------- //
export type Side = "a" | "b";

export interface JudgeVerdict {
  winner: Side | "tie";
  scores: Record<Side, { brief: number; quality: number; efficiency: number }>;
  reasoning: string;
  model: string;
  costUsd: number;
}

export interface BattleView {
  id: string;
  createdAt: number;
  brief: string;
  budget: Budget;
  runs: Record<Side, string>;
  contestants: Record<Side, Contestant>;
  status: "running" | "judging" | "done" | "failed";
  judge?: JudgeVerdict;
  judgeError?: string;
  vote?: Side | "tie";
}

export interface LeaderboardRow {
  key: string; // provider:model:persona
  contestant: Contestant;
  battles: number;
  wins: number;
  losses: number;
  ties: number;
  rating: number; // Elo, starts at 1000
  avgUsd: number;
  avgSeconds: number;
}

export interface AgentsConfigView {
  models: ModelOption[];
  personas: { id: PersonaId; label: string; description: string }[];
  tools: { name: string; description: string; vision: boolean }[];
  templates: PipelineSpec[];
  defaultBudget: Budget;
  maxBudget: Budget;
  judge: ModelOption | null;
  mock: boolean;
  videoEnabled: boolean;
  /** Measured per-unit GPU costs used for estimates. */
  prices: { imageUsd: number; videoUsdPerS: number; imageWarmS: number };
}

/** /api/runs/[id]: the run plus what each media id it mentions is. */
export interface RunPollView extends RunView {
  media: Record<string, { kind: "image" | "video"; prompt: string }>;
}
