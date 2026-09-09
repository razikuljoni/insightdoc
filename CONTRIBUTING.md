# Contributing to InsightDoc

Thanks for helping improve InsightDoc! This guide covers the local workflow and the
quality bar for pull requests.

## Getting started

```bash
git clone https://github.com/YOUR_USERNAME/insightdoc.git
cd insightdoc
bun install                # or npm install
cp .env.example .env
bun run db:push            # create the SQLite database
bun run dev                # http://localhost:3000
```

## Repository conventions

- **Language**: TypeScript everywhere, strict mode. No `any` in new code
  (use `unknown` + narrowing or Zod schemas).
- **Validation**: API inputs are validated with Zod schemas (`src/lib/types.ts` is the
  source of truth for shared DTOs).
- **Client/server split**: `z-ai-web-dev-sdk` and any credential-bearing code must stay
  server-side (`src/server/**`). Never import it from client components.
- **Styling**: Tailwind CSS + shadcn/ui primitives (`src/components/ui`). Follow the
  responsive standards already in the codebase — the UI must hold from 320 px upward.
- **DB changes**: edit `prisma/schema.prisma`, then `bun run db:push`. Never commit
  generated databases (`db/*.db` is git-ignored).

## Quality bar (required before opening a PR)

```bash
bun run lint        # zero errors
bun run typecheck   # zero errors (strict)
bun run smoke       # 15/15 checks pass (upload → dedupe → ingest → search → SSE
                    # answer → feedback → digest → cleanup)
```

If your change affects the ingestion pipeline, also test a **scanned** PDF
(`bun scripts/make-scanned-pdf.ts /tmp/scan.pdf`) and verify the OCR path.

## Commit style

Short imperative subject, optional body with context:

```
fix(retrieval): guard RRF fusion against empty keyword results
feat(chat): add per-session export to markdown
docs: document ZAI_* env vars for Vercel
```

## Areas that especially need help

- Postgres + object-storage adapters (see docs/DEPLOYMENT.md "upgrade paths")
- Streaming performance for 100+ message sessions
- Multilingual OCR (tesseract language packs)
- Test coverage for the map-reduce digest ceiling

## Reporting bugs

Open a GitHub issue with: what you did, what you expected, what happened, and the
relevant console/server log excerpt. For security issues, follow
[SECURITY.md](SECURITY.md) instead.
