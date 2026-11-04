"use client";

import { Info } from "lucide-react";
import { useId } from "react";

import { GLOSSARY, type GlossaryKey } from "../glossary";

/**
 * Hover or keyboard-focus tooltip. The bubble is always in the DOM (hidden with
 * CSS) and linked with aria-describedby, so screen readers get it too.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  className = "",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  const id = useId();
  const pos = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  }[side];
  return (
    <span className={`group/tip relative inline-flex ${className}`} aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute z-50 w-64 rounded-lg border border-border bg-card px-3 py-2 text-left text-xs leading-relaxed font-normal normal-case tracking-normal text-foreground hidden shadow-lg group-focus-within/tip:block group-hover/tip:block ${pos}`}
      >
        {content}
      </span>
    </span>
  );
}

/** ⓘ icon that explains a term from the glossary. */
export function InfoTip({ term, side }: { term: GlossaryKey; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip content={GLOSSARY[term]} side={side}>
      <button
        type="button"
        className="inline-flex text-subtle hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        aria-label="What does this mean?"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** A label followed by its ⓘ. */
export function Term({ term, children, side }: { term: GlossaryKey; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <InfoTip term={term} side={side} />
    </span>
  );
}
