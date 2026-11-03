import type { Metadata } from "next";

import Studio from "@/components/studio/Studio";

// The root layout's title template only applies to child segments, so set the full title here.
export const metadata: Metadata = { title: { absolute: "Studio · FLUX Studio" } };

export default function Home() {
  return <Studio />;
}
