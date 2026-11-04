import type { Metadata } from "next";

import FineTune from "@/components/lora/FineTune";

export const metadata: Metadata = { title: "Fine-tune" };

export default function LoraPage() {
  return <FineTune />;
}
