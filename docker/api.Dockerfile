# syntax=docker/dockerfile:1
# API 镜像（§16.4）：deps → builder → runner，多阶段；argon2 等原生模块在 builder 内编译出 arm64 产物。
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/schemas/package.json packages/schemas/
COPY packages/database/package.json packages/database/
COPY packages/x-client/package.json packages/x-client/
COPY packages/binance-client/package.json packages/binance-client/
COPY packages/queue/package.json packages/queue/
COPY packages/ai/package.json packages/ai/
COPY workers/package.json workers/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @x-square/database build && pnpm -r build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/packages ./packages
COPY --from=builder --chown=app:app /app/workers ./workers
COPY --from=builder --chown=app:app /app/apps/api ./apps/api
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/package.json /app/pnpm-workspace.yaml ./
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
