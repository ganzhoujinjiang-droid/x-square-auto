# syntax=docker/dockerfile:1
# Worker 镜像：与 api 共享构建层，入口换成 workers（§16.2 单进程跑全部 worker）。
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
RUN pnpm -r build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/packages ./packages
COPY --from=builder --chown=app:app /app/workers ./workers
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/package.json /app/pnpm-workspace.yaml ./
USER app
# 媒体临时目录归 worker 所有（§12）；启动时 image-worker 会清空残留
RUN mkdir -p /tmp/x-square-media && chown app:app /tmp/x-square-media
CMD ["node", "workers/dist/index.js"]
