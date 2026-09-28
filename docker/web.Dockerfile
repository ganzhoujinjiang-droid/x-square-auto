# syntax=docker/dockerfile:1
# Web 镜像：next build 在 builder 完成（§16.1 CPU 约束），runner 只跑 next start。
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY apps/web ./apps/web
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm exec next build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && groupadd -r app && useradd -r -g app app
COPY --from=builder --chown=app:app /app/apps/web/.next ./.next
COPY --from=builder --chown=app:app /app/apps/web/public ./public
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/apps/web/package.json ./package.json
USER app
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
