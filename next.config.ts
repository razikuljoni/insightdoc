import type { NextConfig } from "next";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:../db/custom.db";
}

/**
 * InsightDoc — Next.js configuration (production)
 *
 * - `output: "standalone"` is OPT-IN via BUILD_STANDALONE=1 (see
 *   `bun run build:standalone`) for Docker / bare-metal self-hosting.
 *   Vercel builds its own optimized output and should NOT use standalone.
 * - `serverExternalPackages`: native / worker-script modules must NOT be
 *   bundled — tesseract.js resolves its worker-script via __dirname (Next
 *   rewrites it to /ROOT → MODULE_NOT_FOUND), and @napi-rs/canvas ships
 *   platform .node binaries.
 * - Security headers are applied to every route (see headers()).
 */
const nextConfig: NextConfig = {
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  reactStrictMode: false,
  poweredByHeader: false,
  typescript: {
    // src/ is fully type-clean (verified by `bun run typecheck`); the strict
    // flag is intentionally ON so production builds fail loudly on
    // regressions. Non-product folders (examples/, scripts/, skills/) are
    // excluded from the type-check surface in tsconfig.json.
    ignoreBuildErrors: false,
  },
  serverExternalPackages: ["tesseract.js", "@napi-rs/canvas"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), payment=()",
          },
        ],
      },
      {
        // Uploaded PDFs and AI route payloads are per-user data — never cache.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
