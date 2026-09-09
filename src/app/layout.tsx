import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Canonical site origin — set NEXT_PUBLIC_SITE_URL in production (Vercel Project Env or .env). */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://insightdoc.vercel.app";

const TITLE = "InsightDoc — Autonomous PDF Analytics & Vector Search Pipeline";
const DESCRIPTION =
  "Enterprise RAG platform: ingest dense PDFs into a chunked vector index, then interrogate them with streamed, citation-grounded answers, page-accurate deep links, AI digests, OCR for scanned documents, and usage analytics.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · InsightDoc",
  },
  description: DESCRIPTION,
  applicationName: "InsightDoc",
  keywords: [
    "RAG",
    "retrieval augmented generation",
    "vector search",
    "PDF analytics",
    "document intelligence",
    "enterprise search",
    "semantic search",
    "hybrid search",
    "PDF chat",
    "citation grounding",
    "OCR",
    "document summarization",
    "Next.js",
    "Prisma",
    "open source",
  ],
  authors: [{ name: "InsightDoc Contributors" }],
  creator: "InsightDoc Contributors",
  publisher: "InsightDoc",
  category: "productivity",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "InsightDoc",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  formatDetection: {
    telephone: false,
    email: false,
    address: false,
  },
  appleWebApp: {
    capable: true,
    title: "InsightDoc",
    statusBarStyle: "black-translucent",
  },
  // Icons, OpenGraph/Twitter images, and manifest are provided via the
  // Next.js file conventions in src/app (icon.svg, icon.png, favicon.ico,
  // apple-icon.png, opengraph-image.png, twitter-image.png, manifest.ts).
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0F172A" },
    { media: "(prefers-color-scheme: light)", color: "#F8FAFC" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster position="bottom-right" closeButton />
      </body>
    </html>
  );
}
