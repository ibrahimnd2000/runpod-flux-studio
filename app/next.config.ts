import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image that runs on a Runpod CPU pod.
  output: "standalone",
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
