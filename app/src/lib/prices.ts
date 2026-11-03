import prices from "./prices.generated.json";

// Generated from bench/prices.yaml by scripts/sync-prices.mjs (runs on prebuild).
const perHour = prices.per_hour as Record<string, number>;

export const pricesChecked = String(prices.checked);

/** Cost of one request: executionTime x the serving GPU's list price per second. */
export function requestCost(gpu: string | undefined, executionMs: number | undefined): number | undefined {
  if (!gpu || executionMs === undefined || !(gpu in perHour)) return undefined;
  return (executionMs / 1000) * (perHour[gpu] / 3600);
}

export function pricePerHour(gpu: string): number | undefined {
  return perHour[gpu];
}
