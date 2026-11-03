import type { Metadata } from "next";

import AgentPlayground from "@/components/agents/AgentPlayground";

export const metadata: Metadata = { title: "Agent playground" };

export default function Page() {
  return <AgentPlayground />;
}
