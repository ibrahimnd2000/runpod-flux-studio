// Copies the GPU price table from bench/prices.yaml (the single source of truth)
// into src/lib/prices.generated.json so the app and the benchmark agree.
// Runs before `next build`; skipped when bench/ isn't present (e.g. inside Docker,
// where the committed JSON is used).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "bench", "prices.yaml");
const out = join(here, "..", "src", "lib", "prices.generated.json");

if (!existsSync(src)) {
  console.log(`sync-prices: ${src} not found, keeping committed ${out}`);
} else {
  const prices = parse(readFileSync(src, "utf8"));
  writeFileSync(out, JSON.stringify(prices, null, 2) + "\n");
  console.log(`sync-prices: wrote ${out}`);
}
