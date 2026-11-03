export const secs = (ms?: number | null, digits = 1) =>
  ms === undefined || ms === null ? "–" : `${(ms / 1000).toFixed(digits)} s`;

export const usd = (v?: number | null) =>
  v === undefined || v === null ? "–" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;

export const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

export const shortGpu = (gpu?: string) =>
  gpu ? gpu.replace("NVIDIA ", "").replace("GeForce ", "").replace(" Generation", "") : "–";
