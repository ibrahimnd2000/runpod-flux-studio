import Link from "next/link";

import Dashboard from "@/components/Dashboard";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">FLUX Studio on Runpod Serverless</h1>
          <p className="mt-1 text-sm text-subtle">
            Text → product image with FLUX.1-dev on a Runpod Serverless endpoint. Every request shows where its time and
            money went.
          </p>
        </div>
        <Link href="/about" className="text-sm text-accent hover:underline">
          How it works →
        </Link>
      </header>
      <Dashboard />
    </main>
  );
}
