"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// A small snake game to pass the time while a GPU works. The snake eats glowing
// "pixels"; every pixel makes it longer and a little faster. Keyboard input is only
// captured while the game is running, never while typing in a field.

const GRID = 18;
const START_MS = 140;
const MIN_MS = 60;
const BEST_KEY = "flux-studio-snake-best";

type Pt = { x: number; y: number };
type Dir = Pt;

const DIRS: Record<string, Dir> = {
  ArrowUp: { x: 0, y: -1 },
  KeyW: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  KeyS: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  KeyA: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  KeyD: { x: 1, y: 0 },
};

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

function freeCell(snake: Pt[]): Pt {
  for (;;) {
    const p = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
    if (!snake.some((s) => s.x === p.x && s.y === p.y)) return p;
  }
}

function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export default function WaitingGame({
  paused: externalPause,
  statusLine,
  onDone,
  doneLabel,
}: {
  /** The job finished: freeze the game. */
  paused?: boolean;
  /** Shown above the board, e.g. "Step 14/28". */
  statusLine?: string;
  /** When set (job done), shows a button to leave the game. */
  onDone?: () => void;
  doneLabel?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    snake: [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }] as Pt[],
    dir: { x: 1, y: 0 } as Dir,
    queued: [] as Dir[],
    food: { x: 13, y: 9 } as Pt,
    ms: START_MS,
  });
  const [score, setScore] = useState(0);
  const scoreRef = useRef(0);
  const [best, setBest] = useState(0);
  const [phase, setPhase] = useState<"ready" | "playing" | "paused" | "over">("ready");
  const touch = useRef<Pt | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setBest(readBest()), 0);
    return () => clearTimeout(t);
  }, []);

  const draw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const size = c.width;
    const cell = size / GRID;
    const s = state.current;
    ctx.fillStyle = cssVar("--muted", "#1d1d23");
    ctx.fillRect(0, 0, size, size);
    // Food: a soft glowing pixel.
    const accent = cssVar("--accent", "#a78bfa");
    ctx.shadowColor = "#f59e0b";
    ctx.shadowBlur = cell * 0.8;
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(s.food.x * cell + cell * 0.25, s.food.y * cell + cell * 0.25, cell * 0.5, cell * 0.5);
    ctx.shadowBlur = 0;
    // Snake: head brightest, tail fades.
    s.snake.forEach((p, i) => {
      ctx.globalAlpha = Math.max(1 - i / (s.snake.length + 4), 0.35);
      ctx.fillStyle = accent;
      const pad = i === 0 ? 1 : 2;
      ctx.beginPath();
      ctx.roundRect(p.x * cell + pad, p.y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.25);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }, []);

  const reset = useCallback(() => {
    const snake = [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }];
    state.current = { snake, dir: { x: 1, y: 0 }, queued: [], food: freeCell(snake), ms: START_MS };
    scoreRef.current = 0;
    setScore(0);
    draw();
  }, [draw]);

  // Size the canvas to its box (crisp on HiDPI) and draw the first frame.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const fit = () => {
      const px = Math.floor(c.getBoundingClientRect().width * (window.devicePixelRatio || 1));
      c.width = c.height = px - (px % GRID);
      draw();
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [draw]);

  // Game loop.
  useEffect(() => {
    if (phase !== "playing" || externalPause) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const s = state.current;
      const next = s.queued.shift();
      if (next && !(next.x === -s.dir.x && next.y === -s.dir.y)) s.dir = next;
      const head = { x: (s.snake[0].x + s.dir.x + GRID) % GRID, y: (s.snake[0].y + s.dir.y + GRID) % GRID };
      if (s.snake.some((p) => p.x === head.x && p.y === head.y)) {
        setPhase("over");
        const sc = scoreRef.current;
        if (sc > readBest()) {
          try {
            localStorage.setItem(BEST_KEY, String(sc));
          } catch {}
          setBest(sc);
        }
        return;
      }
      s.snake.unshift(head);
      if (head.x === s.food.x && head.y === s.food.y) {
        s.food = freeCell(s.snake);
        s.ms = Math.max(MIN_MS, s.ms - 4);
        scoreRef.current += 1;
        setScore(scoreRef.current);
      } else {
        s.snake.pop();
      }
      draw();
      timer = setTimeout(step, s.ms);
    };
    timer = setTimeout(step, state.current.ms);
    return () => clearTimeout(timer);
  }, [phase, externalPause, draw]);

  // Keyboard: only while the game is active, and never when typing in a field.
  useEffect(() => {
    if (phase === "ready" || phase === "over") return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.code === "Space") {
        e.preventDefault();
        setPhase((p) => (p === "playing" ? "paused" : "playing"));
        return;
      }
      const d = DIRS[e.code];
      if (d && phase === "playing") {
        e.preventDefault();
        state.current.queued.push(d);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  const start = () => {
    if (phase === "over") reset();
    setPhase("playing");
    canvas.current?.focus();
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const from = touch.current;
    const t = e.changedTouches[0];
    touch.current = null;
    if (!from || phase !== "playing") return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    state.current.queued.push(Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) });
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3">
      <div className="flex w-full max-w-sm items-center justify-between text-xs">
        <span className="text-subtle">{statusLine}</span>
        <span className="font-mono">
          {score} <span className="text-subtle">· best {Math.max(best, score)}</span>
        </span>
      </div>
      <div className="relative w-full max-w-sm">
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label="Snake game: arrow keys or WASD to steer, space to pause"
          className="aspect-square w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
          onTouchEnd={onTouchEnd}
        />
        {(phase !== "playing" || externalPause) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-black/45 text-center text-white backdrop-blur-[1px]">
            {onDone ? (
              <>
                <p className="text-sm font-medium">{doneLabel ?? "Your result is ready"}</p>
                <button type="button" onClick={onDone} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white">
                  Show it
                </button>
              </>
            ) : phase === "over" ? (
              <>
                <p className="text-sm font-medium">Game over · {score} pixels</p>
                <button type="button" onClick={start} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium">
                  <RotateCcw className="h-3.5 w-3.5" /> Play again
                </button>
              </>
            ) : (
              <>
                <p className="max-w-[14rem] text-xs opacity-90">Eat the glowing pixels. Arrows / WASD or swipe; space pauses.</p>
                <button type="button" onClick={start} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium">
                  <Play className="h-3.5 w-3.5" />
                  {phase === "paused" ? "Resume" : "Start"}
                </button>
              </>
            )}
          </div>
        )}
        {phase === "playing" && !externalPause && (
          <button
            type="button"
            onClick={() => setPhase("paused")}
            className="absolute top-2 right-2 rounded bg-black/40 p-1 text-white"
            aria-label="Pause"
          >
            <Pause className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
