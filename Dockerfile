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

RUN apk add --no-cache tini

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/dist-server/ dist-server/

RUN mkdir -p data

ENV NODE_ENV=production
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist-server/index.js"]
