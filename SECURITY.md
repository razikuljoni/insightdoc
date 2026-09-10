# Security Policy

## Reporting a vulnerability

Do **not** open a public issue for security problems. Email the maintainers or use
GitHub's private vulnerability reporting (**Security → Report a vulnerability**).

Include: affected component/endpoint, reproduction steps, impact assessment, and any
proof-of-concept. You can expect an initial response within 7 days. Please give us
reasonable time to patch before public disclosure.

## Hardening notes

InsightDoc's default configuration targets local/single-team use. Points to review
before exposing it publicly:

| Area | Default behavior | Hardening guidance |
|---|---|---|
| Auth | Single implicit demo user (`getCurrentUser`) — no login | Put the app behind your SSO/reverse-proxy auth, or wire NextAuth (dependency already present) |
| Uploads | MIME + extension + size validation, SHA-256 dedupe, UUID storage keys, no user-controlled paths | Keep the size limit sane for your storage backend |
| File serving | PDFs stream back only through `/api/v1/documents/:id/file` with server-generated keys | Keep `storage/` out of any public static path (already git-ignored) |
| AI routes | Credentials live server-side only (`src/server/zai.ts`); SDK is never bundled client-side | Provide `AI_API_KEY`/`AI_BASE_URL` via platform secrets, never in client code |
| Headers | `nosniff`, `SAMEORIGIN`, `strict-origin-when-cross-origin`, scoped `Permissions-Policy`, `no-store` on `/api/*` (see `next.config.ts`) | Add a CSP tailored to your deployment if you embed the app |
| SQL | Prisma parameterized queries everywhere; no raw SQL string building | — |
| Dependencies | `bun.lock` pins the tree; renovate/audit in CI | Run `bun pm audit` (or `npm audit`) as part of your pipeline |

## Data handling

Uploaded documents, extracted text, chunks and chat transcripts are stored in the
configured database / storage layer. Treat them as sensitive: when self-hosting,
encrypt at rest at the volume level and scope backups accordingly.
