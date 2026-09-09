# InsightDoc — API Reference

Base path: `/api/v1` · Content type: `application/json` (unless noted) ·
All AI-adjacent routes are server-only; credentials never reach the client.

Conventions:
- Errors return `{ error: string }` with an appropriate 4xx/5xx status.
- IDs are UUIDs (workspace/document/chat IDs are server-generated).
- `409` signals checksum de-duplication on upload.

## Workspaces

| Method | Path | Description |
|---|---|---|
| `GET` | `/workspaces` | List workspaces |
| `POST` | `/workspaces` | Create workspace |
| `GET/PATCH/DELETE` | `/workspaces/:workspaceId` | Inspect / rename / delete (cascades) |
| `GET/POST/DELETE` | `/workspaces/:workspaceId/tags` | Tag governance (list / create / delete) |

## Documents & ingestion

| Method | Path | Description |
|---|---|---|
| `GET` | `/workspaces/:workspaceId/documents` | List documents (status, meta, tags) |
| `POST` | `/workspaces/:workspaceId/documents/upload` | **Multipart** PDF upload → dedupe (SHA-256, `409` on dup) → persist → enqueue ingestion. Returns `{ documentId, fileKey }` |
| `GET` | `/documents` | Cross-workspace document listing |
| `GET` | `/documents/:documentId` | Document detail (incl. tags, meta) |
| `PATCH/DELETE` | `/documents/:documentId` | Rename / retag / delete (removes chunks + file) |
| `GET` | `/documents/:documentId/status` | Ingestion status polling: `{ status, progress, pageCount, chunkCount, errorMessage, statusDetail }` |
| `POST` | `/documents/:documentId/process` | (Re)trigger ingestion (retry FAILED / re-embed) |
| `GET` | `/documents/:documentId/file` | **Streams the original PDF** (`application/pdf`) |
| `GET` | `/documents/:documentId/chunks` | Inspect indexed chunks (debug/QA) |
| `GET` | `/documents/:documentId/summary` | Cached AI digest (`404` if none) |
| `POST` | `/documents/:documentId/summary[?force=1]` | Generate/regenerate digest (map-reduce for long docs) |
| `POST` | `/documents/:documentId/summary/share` | Share digest into a chat (`sessionId` optional → creates/uses session) |

## Search

| Method | Path | Description |
|---|---|---|
| `POST` | `/search` | Hybrid retrieval (BM25 + cosine + RRF + rerank). Body: `{ workspaceId, query, topK?, documentIds? }` → ranked passages with scores + page refs |

## Chat

| Method | Path | Description |
|---|---|---|
| `GET/POST` | `/chats` | List / create sessions |
| `GET/PATCH/DELETE` | `/chats/:sessionId` | Messages & meta / rename, pin / delete |
| `POST` | `/chats/:sessionId/stream` | **SSE** grounded answer. Body: `{ workspaceId, question, documentIds? }`. Frame order: `citations` → `retrieval` → `token`* → `done { messageId, totalTokens, latencyMs }` |
| `POST` | `/chats/:sessionId/messages` | Persist a turn (notes/artifacts flow) |
| `POST` | `/chats/:sessionId/followups` | Generate follow-up question suggestions |
| `GET` | `/chats/:sessionId/export` | Session export (markdown download) |

## Analytics & activity

| Method | Path | Description |
|---|---|---|
| `GET` | `/analytics?workspaceId=` | Aggregates: tokens, cost, latency percentiles, ingest throughput, feedback stats |
| `GET` | `/activity?workspaceId=` | Recent activity feed |
| `GET/POST` | `/feedback-review` | Feedback loop: list / resolve flagged answers (human review queue) |

## Audio (voice I/O)

| Method | Path | Description |
|---|---|---|
| `POST` | `/audio/transcribe` | **Multipart** `audio` field → `{ text }` (speech-to-text) |
| `POST` | `/audio/speech` | `{ text }` → single seamless `audio/wav` narration (sentence-split, PCM-merged; 1024-char/request cap handled server-side) |

## SSE frame contract (`/chats/:sessionId/stream`)

```
event: citations   data: [{ documentId, documentTitle, page, snippet }, ...]
event: retrieval   data: { strategy, candidates, fusedTopK, latencyMs }
event: token       data: { delta }
event: done        data: { messageId, totalTokens, latencyMs }
```

Clients should render tokens as they arrive and attach citation chips once the
`citations` frame lands (it precedes the token stream by design).

## Example — upload + ingest + ask

```bash
curl -F "file=@report.pdf" \
  http://localhost:3000/api/v1/workspaces/$WS/documents/upload
# → { "documentId": "…", "fileKey": "uploads/….pdf" }

curl http://localhost:3000/api/v1/documents/$DOC/status
# → { "status": "COMPLETED", "chunkCount": 42, ... }

curl -N -X POST http://localhost:3000/api/v1/chats/$CHAT/stream \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"'$WS'","question":"What are the payment terms?"}'
# → SSE frames (see contract above)
```
