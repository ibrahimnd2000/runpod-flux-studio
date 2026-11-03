"use client";

/**
 * Inline status message. `warn` is for transient problems where the UI keeps
 * working (stale data, retrying); `error` is for things the user must act on or
 * that ended a job.
 */
export default function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "error";
  title: string;
  children?: React.ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300"
      : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      <p className="font-medium">{title}</p>
      {children && <p className="mt-0.5 text-xs opacity-90">{children}</p>}
    </div>
  );
}

