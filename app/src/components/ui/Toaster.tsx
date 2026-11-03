"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import { createContext, useCallback, useContext, useState } from "react";

type Toast = { id: number; tone: "success" | "error"; message: string };

const ToastContext = createContext<(tone: Toast["tone"], message: string) => void>(() => {});

/** Short confirmations ("Seed copied", "2 images deleted") in the bottom-right corner. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback((tone: Toast["tone"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm shadow-lg"
          >
            {t.tone === "success" ? (
              <Check className="h-4 w-4 text-emerald-500" aria-hidden />
            ) : (
              <AlertTriangle className="h-4 w-4 text-red-500" aria-hidden />
            )}
            {t.message}
            <button type="button" onClick={() => dismiss(t.id)} className="ml-2 text-subtle hover:text-foreground" aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
