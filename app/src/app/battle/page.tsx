import type { Metadata } from "next";

import Battleground from "@/components/agents/Battleground";

export const metadata: Metadata = { title: "Battleground" };

export default function Page() {
  return <Battleground />;
}
