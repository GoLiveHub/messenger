# ===================== Stage 1: Builder =====================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ src/
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public/ public/

RUN npm run build

# ===================== Stage 2: Runner =====================
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache tini && apk add --no-cache wget bash

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/dist-server/ dist-server/

ENV NODE_ENV=production
ENV PORT=3001

# Non-root user + writable data dir.
# NOTE: Railway mounts the Volume over /app/data as root, which would make the
# SQLite database unwritable for a non-root user. Running as root keeps the
# volume usable; if you re-enable `USER appuser`, wire an entrypoint that
# chowns /app/data (as root) before dropping privileges.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/data /app/data/storage /app/data/backups \
    && chown -R appuser:appgroup /app/data

USER root

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=20s \
  CMD wget -q -O /dev/null http://localhost:3001/api/health/readiness || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist-server/index.js"]