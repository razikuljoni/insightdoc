# Deploying InsightDoc

InsightDoc ships as a standard Next.js 16 (App Router) application and deploys anywhere
Node.js ≥ 20.9 runs. This guide covers the three supported paths and the honest trade-offs
of each, plus the database/storage upgrade paths for serverless platforms.

## At a glance

| Path | Persistence | Best for |
|---|---|---|
| **Vercel** (+ hosted Postgres & blob storage) | ✅ durable | Public demos, team deployments, zero-ops |
| **Vercel** (as-is, SQLite) | ⚠️ ephemeral (read-only FS) | UI/UX evaluation only |
| **Docker / compose** | ✅ durable (volumes) | Self-hosting with full functionality |
| **Bare metal / any Node host** | ✅ durable | VPS, on-prem |

> **Why the caveat on Vercel?** InsightDoc's zero-config defaults are **SQLite**
> (`db/custom.db`) and **local-disk** storage (`storage/uploads/`). Vercel's serverless
> filesystem is ephemeral and read-only outside `/tmp`, so those defaults cannot persist
> data there. The app *deploys and boots fine*; durable persistence needs the upgrade
> paths below (Postgres + external storage). On Docker/VPS both defaults work unchanged.

---

## 1. Vercel

### 1.1 Deploy the app (5 minutes)

1. Push the repository to GitHub (see README → *Ready to push* checklist below if needed).
2. [vercel.com/new](https://vercel.com/new) → **Import** the repository.
   Vercel auto-detects Next.js (framework preset is pinned in `vercel.json`) and runs
   `bun install` + `bun run build` (the `postinstall` hook runs `prisma generate`).
3. Configure **Environment Variables** (Project → Settings → Environment Variables)
   for *Production*, *Preview* and *Development*:

   | Variable | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | your database URL | See §1.2 — SQLite works only for UI evaluation |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-app>.vercel.app` | Drives SEO/OG/canonical/sitemap URLs |
   | `ZAI_API_KEY` | your AI provider key | **Required on Vercel** — the SDK's `.z-ai-config` file doesn't exist there |
   | `ZAI_BASE_URL` | your AI provider base URL | Must accompany the key (e.g. `https://api.z.ai/api/paas/v4`) |

4. **Deploy.** First build takes ~2–3 minutes. Every push to `main` redeploys; PRs get
   preview URLs automatically.

### 1.2 Database upgrade path (SQLite → Postgres)

Required for real usage on Vercel. Prisma makes this a small, mechanical change:

1. Provision Postgres — [Vercel Postgres](https://vercel.com/storage/postgres),
   [Neon](https://neon.tech) or [Supabase](https://supabase.com) all work (all offer
   free tiers).
2. In `prisma/schema.prisma`, switch the provider:

   ```prisma
   datasource db {
     provider = "postgresql"          // was "sqlite"
     url      = env("DATABASE_URL")
   }
   ```

3. Audit SQLite-only column types in the schema (`String` JSON blobs stay valid; native
   `Json` fields are an optional improvement) — the default schema is written to port
   cleanly.
4. Set `DATABASE_URL` to the Postgres connection string in Vercel env vars, then from
   your machine (with the same URL in `.env`):

   ```bash
   bun run db:push        # or: bunx prisma migrate dev --name init
   ```

5. Redeploy. `postinstall` already regenerates the Prisma client for the new provider.

> **Performance note**: serverless functions open a new DB connection per cold start —
> use a pooler endpoint (Neon/Vercel/Supabase all provide one, typically port `6543`)
> to stay under connection limits.

### 1.3 Storage upgrade path (local disk → blob storage)

`src/server/storage.ts` wraps all file I/O behind four functions
(`ensureStorageRoot`, `writeDocumentFile`, `absolutePathFor`, delete/stream helpers).
Port this module to your provider — the function signatures are already
conceptually S3-compatible:

- **Vercel Blob** — `@vercel/blob` `put()`/`head()` (closest to the existing interface).
- **AWS S3 / Cloudflare R2** — presigned PUT from the upload route, stream GET in the
  file route.

Until swapped, uploads on Vercel land in `/tmp` and die with the invocation: documents
can be ingested and indexed (chunks/embeddings live in the DB), but the *original PDF*
won't survive — so the PDF viewer pane will 404 after the request ends while chat and
search keep working. Plan the storage port for a complete experience.

### 1.4 Vercel function behavior

- Heavy routes (`upload`, `process`, `summary`, `stream`, `search`, `audio/*`) export
  `maxDuration` (60–120 s) — within Hobby limits. Long OCR jobs on big scans benefit
  from Pro (up to 300 s).
- SSE streaming (chat answers) works on the Node.js runtime out of the box.
- The in-process job queue is per-instance; with Fluid Compute this is fine for
  team-scale traffic. For heavy concurrent ingestion, see
  [ARCHITECTURE.md](ARCHITECTURE.md) → "Scaling the queue" (BullMQ/QStash swap).

---

## 2. Docker

A production `Dockerfile` and `docker-compose.yml` are included. The container runs the
standalone Next.js server with SQLite + local disk on mounted volumes — **full
functionality, no external services**.

```bash
docker compose up --build      # http://localhost:3000
```

Compose mounts two volumes:

- `insightdoc-db` → `/app/db` (SQLite database)
- `insightdoc-storage` → `/app/storage` (uploaded PDFs)

Environment variables can be overridden in the `environment:` block
(`ZAI_*` if you don't bake a `.z-ai-config`).

<details>
<summary>Bare Docker (without compose)</summary>

```bash
docker build -t insightdoc .
docker run -p 3000:3000 \
  -v insightdoc-db:/app/db \
  -v insightdoc-storage:/app/storage \
  -e DATABASE_URL="file:/app/db/custom.db" \
  insightdoc
```
</details>

## 3. Bare metal / any Node host

```bash
bun install                    # or npm ci
bun run db:push                # create/migrate the database
bun run build:standalone       # produces .next/standalone with static assets
bun start                      # serves on $PORT (default 3000)
```

Run behind a reverse proxy (Caddy/Nginx) for TLS. Set `NEXT_PUBLIC_SITE_URL` to the
public origin so SEO metadata resolves correctly.

---

## Post-deploy verification

1. Open the site — landing view renders, no console errors.
2. Upload a PDF → toast `"<title>" finished processing · N chunks indexed`.
3. Ask a question in Chat → streamed answer with page citations; click a citation →
   PDF viewer jumps to the page.
4. `GET /robots.txt` shows the sitemap; `GET /sitemap.xml` resolves; share a link in a
   chat app and confirm the OG card (title + 1200×630 image) renders.
5. If AI answers fail with a config error on Vercel → `ZAI_API_KEY`/`ZAI_BASE_URL`
   are missing or partially set (both or neither).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `PrismaClientInitializationError: file does not exist` | `DATABASE_URL` points to a path that isn't created | Run `bun run db:push` locally against the same URL; on Vercel use Postgres (§1.2) |
| `attempt to write a readonly database` (Vercel) | SQLite on read-only serverless FS | Upgrade to Postgres (§1.2) |
| AI routes 500 with config-not-found | SDK can't find `.z-ai-config` | Set `ZAI_API_KEY` **and** `ZAI_BASE_URL` |
| OG image 404 in social scrapers | `NEXT_PUBLIC_SITE_URL` unset/wrong | Set it to the public origin and redeploy |
| OCR timeout on large scans | Function duration cap | Raise plan limits (Pro) or lower `INSIGHTDOC_OCR_MAX_PAGES` |
| `prisma generate` missing types in CI | Dependency install skipped scripts | Ensure `postinstall` isn't disabled (`npm ci --ignore-scripts` off) |
