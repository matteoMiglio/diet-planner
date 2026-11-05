# syntax=docker/dockerfile:1

# The build output is plain JavaScript, so build once on the builder's own platform and
# copy the result into each target platform's runtime image (no emulation needed).
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.16.1
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @diet/web build && pnpm --filter @diet/api build

FROM node:24-alpine AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/public \
    MIGRATIONS_DIR=/app/drizzle \
    APP_VERSION=$APP_VERSION
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/drizzle ./drizzle
COPY --from=build /repo/apps/web/dist ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/server.mjs"]
