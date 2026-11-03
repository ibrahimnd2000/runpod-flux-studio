import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import AppShell from "@/components/AppShell";
import { EndpointProvider } from "@/components/EndpointProvider";
import { ToastProvider } from "@/components/ui/Toaster";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s · FLUX Studio",
    default: "FLUX Studio · Product images on Runpod Serverless",
  },
  description:
    "Generate product images with FLUX.1-dev on a Runpod Serverless GPU endpoint, with live queue, cold-start, latency and cost visibility for every request.",
  applicationName: "FLUX Studio",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0e" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <ToastProvider>
          <EndpointProvider>
            <AppShell>{children}</AppShell>
          </EndpointProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
