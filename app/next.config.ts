import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image that runs on a Runpod CPU pod.
  output: "standalone",
  // Runpod's HTTP proxy is behind Cloudflare, which honours Next's default
  // `s-maxage=31536000` on prerendered pages and kept serving old HTML after a
  // deploy. Pages are tiny; always revalidate them. Hashed /_next/static assets
  // stay immutable.
  async headers() {
    return ["/", "/library", "/about"].map((source) => ({
      source,
      headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
    }));
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
