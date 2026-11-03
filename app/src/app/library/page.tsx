import Link from "next/link";

import Library from "@/components/Library";

export default function LibraryPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Media library</h1>
          <p className="mt-1 text-sm text-subtle">
            Every generated image, stored on the app pod&apos;s Runpod network volume. Deleting needs the access code.
          </p>
        </div>
        <Link href="/" className="text-sm text-accent hover:underline">
          ← Back to the demo
        </Link>
      </header>
      <Library />
    </main>
  );
}
