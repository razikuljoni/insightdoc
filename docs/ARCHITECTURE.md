# InsightDoc — Architecture

This document maps the system end-to-end: pipeline stages, retrieval engine, data
model, and the deliberate abstractions that let every infrastructure piece be swapped
without touching feature code.

## 1. System overview

```
Browser (SPA, /)                     Next.js server
┌──────────────────────┐             ┌──────────────────────────────────────────┐
│ Dashboard  Documents │   REST/SSE  │ /api/v1/*  (route handlers)              │
│ Search  Chat  Analyt.│◄───────────►│   ├─ bootstrap (self-healing workspace)  │
│ command palette      │             │   ├─ audit trail                          │
└──────────┬───────────┘             │   ├─ queue ──► worker (document pipeline) │
           │  zustand store          │   ├─ retriever (hybrid RAG)               │
           └─ fetch + SSE           │   └─ zai (LLM · TTS · ASR, server-only)   │
                                    └───────┬───────────────┬──────────────────┘
                                            │               │
                                     Prisma client    EmbeddingService
                                     (SQLite → PG)    (swappable, 1536-dim)
                                            │               │
                                        db/custom.db   storage/uploads/*
```

- **Frontend** — single page (`/`) with five client-side views; one Zustand store owns
  application state; polling (1.5 s) drives live ingestion progress and completion toasts.
- **API** — REST under `/api/v1` (see [API.md](API.md)); chat answers stream over SSE.
- **Persistence** — Prisma/SQLite by default; all document bytes live outside the DB in
  a storage abstraction.

## 2. Ingestion pipeline

```
upload (multipart, validated)
  └─► SHA-256 checksum ── duplicate? ──► 409 reject (de-duplication)
        └─► Document row (PENDING) + storage write (UUID key)
              └─► enqueue ─► worker:
                    1. EXTRACTING  unpdf text extraction (+page count)
                    2. ── text layer thin? ──► OCR (tesseract.js, ≤ N pages,
                       144 dpi raster via @napi-rs/canvas, live i/N progress)
                    3. CHUNKING    structure-aware splitting, token-budgeted
                    4. EMBEDDING   EmbeddingService per chunk (1536-dim)
                    5. COMPLETED   searchable; status toasts fire on the client
                       (any failure → FAILED + errorMessage + retry affordance)
```

- **Queue**: in-process singleton (survives HMR via globalThis) with retry/backoff;
  phase + progress are persisted on the Document row so any client re-attaches.
- **OCR**: only the pages that need it, capped by `INSIGHTDOC_OCR_MAX_PAGES`
  (default 12) at ~144 dpi — the accuracy/cost sweet spot.

## 3. Retrieval engine (hybrid RAG)

```
query ─┬─ BM25 keyword scoring (tokenizer: lower/stop/light-stem)
       └─ cosine similarity over chunk embeddings
              └─ Reciprocal Rank Fusion (RRF) ─► score-weighted rerank
                    └─ top-k passages → strict grounding prompt → LLM (SSE)
```

- Answers must cite retrieved passages; each citation carries `{page, snippet}` and
  the client deep-links into the PDF viewer at that page.
- Follow-up suggestions and digests reuse the same grounding contract.

## 4. Data model (Prisma)

Core relations (see `prisma/schema.prisma` for the full picture):

```
Workspace 1─* Document 1─* Chunk (embedding JSON TEXT, 1536-dim)
Workspace 1─* ChatSession 1─* ChatMessage (role, content, citations JSON,
                                         feedback, usage: tokens/cost/latency)
Document 1─1 summary payload (cached digest: overview/keyPoints/entities,
             invalidated on document change)
Workspace 1─* TagDocument (governance), AuditEvent (trail)
```

SQLite notes: embeddings are stored as JSON TEXT; the schema is intentionally portable
to Postgres (swap the provider, push, done).

## 5. Deliberate abstractions (swap points)

| Concern | Module | Default | Production upgrade |
|---|---|---|---|
| Database | `prisma/schema.prisma` | SQLite | PostgreSQL (provider swap + push) |
| Object storage | `src/server/storage.ts` | local disk `storage/uploads/` | S3 / R2 / Vercel Blob (same 4-function surface) |
| Embeddings | `src/lib/embeddings.ts` (`EmbeddingService`) | deterministic local hashed embedder | provider API by implementing the interface |
| LLM / TTS / ASR | `src/server/zai.ts` (`getZAI`) | z-ai-web-dev-sdk | any OpenAI-compatible gateway (env: `ZAI_API_KEY`, `ZAI_BASE_URL`) |
| Job queue | `src/server/queue.ts` | in-process singleton | BullMQ + Redis or QStash for multi-instance scale |
| OCR | `src/server/worker/ocr.ts` | tesseract.js (eng) | language packs / hosted OCR service |

## 6. Security posture

- Server-generated storage keys only (no user-controlled paths).
- Zod validation on API inputs; shared DTO schemas in `src/lib/types.ts`.
- AI credentials never leave the server (`src/server/zai.ts` is server-only).
- Hardening headers + `no-store` on `/api/*` (see `next.config.ts`).
- Audit trail for privileged actions.

## 7. Known trade-offs (v1.0)

- Exact-normalized-string entity matching in digest compare (no containment matching).
- Map-reduce digest ceiling: >60k chars uses the 4-part path (verified at 2 parts).
- In-process queue assumes a single serving instance (Fluid-compatible; swap for
  multi-instance deployments).
- OCR max pages guards cost; larger scans index their first N pages via OCR.
