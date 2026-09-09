# syntax=docker/dockerfile:1
# ============================================================================
# InsightDoc — production container (standalone Next.js server)
#
#   docker build -t insightdoc .
#   docker run -p 3000:3000 \
#     -v insightdoc-db:/app/db -v insightdoc-storage:/app/storage \
#     -e DATABASE_URL="file:/app/db/custom.db" insightdoc
#
# Or simply: docker compose up --build
# ============================================================================
FROM oven/bun:1 AS builder
WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# Copy sources and build the standalone output
COPY . .
ENV BUILD_STANDALONE=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL="file:/app/db/custom.db"
# Create the SQLite database from the schema so the image ships boot-ready
# (named Docker volumes initialize from image content on first mount).
RUN bun run db:generate && bun run db:push && bun run build

# ----------------------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Prisma query engines require openssl
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Standalone build (build script already bundles .next/static + public into it)
COPY --from=builder /app/.next/standalone ./
# Boot-ready SQLite database (initialized into the volume on first mount)
COPY --from=builder /app/db/custom.db ./db/custom.db
COPY --from=builder /app/prisma ./prisma

RUN mkdir -p /app/storage/uploads
VOLUME ["/app/db", "/app/storage"]

EXPOSE 3000
CMD ["node", "server.js"]
