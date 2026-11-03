import type { Metadata } from "next";

import PipelineBuilder from "@/components/agents/PipelineBuilder";

export const metadata: Metadata = { title: "Pipelines" };

export default function Page() {
  return <PipelineBuilder />;
}
