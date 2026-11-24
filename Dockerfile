# syntax=docker/dockerfile:1
# roles: web, api, worker, migrate. No secrets baked in.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY docker/image/prune.mjs ./docker/image/prune.mjs
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN pnpm --filter @vdrkit/core build \
 && pnpm --filter @vdrkit/server build \
 && pnpm --filter @vdrkit/dataroom build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm --filter @vdrkit/server deploy --prod /out/server \
 && rm -rf /out/server/src /out/server/test /out/server/scripts /out/server/tsconfig*.json /out/server/vitest.config.ts  && node docker/image/prune.mjs /out/server
RUN mkdir -p /out/web \
 && cp -r apps/dataroom/.next/standalone/. /out/web/ \
 && cp -r apps/dataroom/.next/static /out/web/apps/dataroom/.next/static

FROM ${NODE_IMAGE} AS runtime
ARG VDRKIT_VERSION=1.0.0
LABEL org.opencontainers.image.title="VDRkit" \
      org.opencontainers.image.description="Open-source virtual data room: web, api, worker and migrate in one image" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/vdrkit/vdrkit" \
      org.opencontainers.image.version="${VDRKIT_VERSION}"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 VDRKIT_VERSION=${VDRKIT_VERSION}
# font: otherwise watermark text renders as boxes
# jemalloc: under glibc malloc the API's RSS grows past its limit while watermarking
# npm/corepack/yarn: unused at run time, noisy in CVE scans
RUN apt-get update  && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core libjemalloc2  && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(ls /usr/lib/*-linux-gnu/libjemalloc.so.2)" /usr/local/lib/libjemalloc.so.2 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2
WORKDIR /app
COPY --from=build --chown=root:root /out/server ./server
COPY --from=build --chown=root:root /out/web ./web
COPY --chown=root:root docker/image/start.mjs docker/image/healthcheck.mjs ./
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["node", "/app/start.mjs"]
CMD ["api"]
