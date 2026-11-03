"use client";

import { useCallback, useEffect, useState } from "react";

const CODE_KEY = "flux-demo-access-code";

/** Access code remembered in this browser (shared by single and bulk generation). */
export function useAccessCode() {
  const [code, setCode] = useState("");

  useEffect(() => {
    // Restore after hydration: localStorage is browser-only.
    const restore = setTimeout(() => {
      try {
        setCode(localStorage.getItem(CODE_KEY) ?? "");
      } catch {}
    }, 0);
    return () => clearTimeout(restore);
  }, []);

  const remember = useCallback((value: string) => {
    try {
      localStorage.setItem(CODE_KEY, value);
    } catch {}
  }, []);

  return { code, setCode, remember };
}
