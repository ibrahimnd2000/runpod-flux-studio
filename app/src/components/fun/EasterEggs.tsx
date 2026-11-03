"use client";

import { useEffect, useRef, useState } from "react";

import { useToast } from "../ui/Toaster";

// Small, harmless surprises. Nothing here calls an API or changes data.

const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "KeyB", "KeyA"];

export const HAIKUS = [
  "Weights stream to the card / thirty gigabytes of light / then: a coffee mug",
  "Queue of one, then none / the worker wakes from its sleep / FlashBoot, warm again",
  "Scale to zero, rest / no GPU hums in the dark / until someone asks",
  "Twenty-eight small steps / noise becomes a leather bag / on a sage green wall",
];

const COLORS = ["#8b5cf6", "#f59e0b", "#10b981", "#0ea5e9", "#ec4899"];

function Confetti({ onEnd }: { onEnd: () => void }) {
  // Positions are random but fixed for this burst; computed once on mount.
  const [pieces] = useState(() =>
    Array.from({ length: 90 }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.4,
      duration: 1.6 + Math.random() * 1.4,
      size: 6 + Math.random() * 6,
      color: COLORS[i % COLORS.length],
      drift: (Math.random() - 0.5) * 160,
      spin: Math.random() * 720,
    })),
  );
  useEffect(() => {
    const t = setTimeout(onEnd, 3200);
    return () => clearTimeout(t);
  }, [onEnd]);
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[70] overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={
            {
              left: `${p.left}%`,
              width: p.size,
              height: p.size * 0.45,
              background: p.color,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              "--drift": `${p.drift}px`,
              "--spin": `${p.spin}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

let fire: (() => void) | null = null;
/** Lets other components (e.g. a lucky seed) trigger the confetti. */
export const celebrate = () => fire?.();

/** Konami code -> confetti. Mount once (in the app shell). */
export default function EasterEggs() {
  const toast = useToast();
  const [burst, setBurst] = useState(0);
  const progress = useRef(0);

  useEffect(() => {
    fire = () => setBurst((b) => b + 1);
    return () => {
      fire = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      progress.current = e.code === KONAMI[progress.current] ? progress.current + 1 : e.code === KONAMI[0] ? 1 : 0;
      if (progress.current === KONAMI.length) {
        progress.current = 0;
        setBurst((b) => b + 1);
        toast("success", "Secret unlocked: GPU go brrr. (Sadly it doesn't make cold starts faster.)");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast]);

  return burst ? <Confetti key={burst} onEnd={() => setBurst(0)} /> : null;
}
