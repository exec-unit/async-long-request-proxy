FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runner inherits corepack/pnpm from base - no need to reinstall via npm install -g
FROM base AS runner
# dumb-init handles PID 1 signals (SIGTERM/SIGINT) for graceful Node.js shutdowns
RUN apk add --no-cache dumb-init

# Create /app owned by the unprivileged node user BEFORE WORKDIR.
# Without this, WORKDIR creates the dir as root, preventing pnpm from writing
# temporary execution scripts and causing EACCES at runtime.
RUN mkdir /app && chown node:node /app
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node --from=deps    /app/node_modules                       ./node_modules
COPY --chown=node:node --from=builder /app/package.json                        ./
COPY --chown=node:node --from=builder /app/dist                                ./dist
COPY --chown=node:node --from=builder /app/drizzle.config.ts                   ./
COPY --chown=node:node --from=builder /app/src/database/drizzle/migrations     ./src/database/drizzle/migrations

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8080/v1/health/live || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "--enable-source-maps", "dist/src/main.js"]
