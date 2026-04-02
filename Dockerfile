# ── Stage 1: Install production deps ─────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: Build TypeScript ─────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma
# Generate Prisma client types (no engine needed for build)
RUN npx prisma generate --no-engine 2>/dev/null || true
RUN npx tsc

# ── Stage 3: Production image ─────────────────────────────────────────────────
FROM node:20-bookworm-slim AS production

# FFmpeg + Vietnamese font support for subtitles
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-noto \
    ca-certificates \
    libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/prisma       ./prisma
COPY package.json ./

# Runtime dirs (override via volume mounts in production)
RUN mkdir -p assets/images tmp outputs/uploads outputs/manual

# Non-root for security
RUN groupadd -r app && useradd -r -g app app && chown -R app:app /app
USER app

RUN ffmpeg -version 2>&1 | head -1

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
