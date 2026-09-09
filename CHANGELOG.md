# Changelog

All notable changes to InsightDoc are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org).

## [1.0.0] — 2025

First production-ready release.

### Added — Platform
- Single-page workspace app with five views: **Dashboard**, **Documents**, **Search**,
  **Chat** (split-screen with PDF viewer), **Analytics**; command palette and keyboard
  shortcuts; dark/light themes; fluid responsive layout from 320 px to 4K.
- Multi-workspace support with self-healing bootstrap.

### Added — Ingestion
- PDF upload with SHA-256 checksum de-duplication, size/type validation and
  background processing via a resilient in-process job queue (retry/backoff,
  DB-persisted phase progress: queued → extracting → chunking → embedding → ready).
- Text extraction with unpdf; **OCR fallback** (tesseract.js) for scanned documents
  with live per-page progress; extractable-page detection.
- Structure-aware chunking with token budgeting.

### Added — Retrieval & Chat
- Hybrid retrieval: BM25 + cosine similarity fused via Reciprocal Rank Fusion with
  score-weighted reranking; swappable `EmbeddingService` (1536-dim default).
- SSE-streamed grounded chat with inline **page-accurate citations**, deep-linked
  into the split-screen PDF viewer; follow-up suggestions; regenerate; feedback loop
  with human review queue; rename/pin/session management; markdown export.
- Cross-document semantic search with workspace/document scoping.

### Added — Knowledge tooling
- **AI digests** (map-reduce for long documents): overview, key points, entities,
  suggested questions; share into current/new chat; **multi-document side-by-side
  compare** with shared-entity highlighting.
- Tag governance, prompt library, document notes/inspector, bulk actions,
  ingestion completion/failure toasts.

### Added — Analytics
- Token & cost tracking with compact axis formatting, latency percentiles, ingest
  throughput, activity feed.

### Added — Voice
- Speech-to-text input and text-to-speech narration merged into a single seamless WAV.

### Added — Production & deployment
- Full SEO layer: Metadata API (OpenGraph/Twitter/canonical), JSON-LD
  (SoftwareApplication + FAQPage), `robots.txt` incl. AI crawlers, `sitemap.xml`,
  PWA manifest, `llms.txt` / `ai.txt`.
- Generated brand kit from `public/brand/*.svg`: multi-size `favicon.ico`,
  SVG/PNG icons, apple-touch-icon, 1200×630 OG/Twitter card.
- Env-aware AI provider bootstrap (`src/server/zai.ts`) enabling serverless
  (Vercel) deployment via `ZAI_API_KEY`/`ZAI_BASE_URL`.
- Security headers; strict type-checking in builds; `postinstall` Prisma generate;
  `vercel.json`; Docker + compose deployment; documentation suite
  (README, DEPLOYMENT, ARCHITECTURE, API, CONTRIBUTING, SECURITY, LICENSE).
- QA harness: `bun run smoke` end-to-end suite (15 checks) and PDF fixture generators.

### Security
- No user-controlled file paths; server-generated storage keys only.
- API responses marked `no-store`; standard hardening headers on all routes.

## [Unreleased]

### Planned
- Postgres provider + hosted object-storage adapters for serverless persistence
  (see docs/DEPLOYMENT.md).
- Optional authentication (NextAuth) for public deployments.
- Chat message virtualization for very long sessions.
