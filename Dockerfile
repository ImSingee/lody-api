# syntax=docker/dockerfile:1.7

# lody needs glibc (@loro-dev/roost-node has no musl build) and Node >=24.22.1.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Keep in sync with "packageManager" in package.json.
ARG PNPM_VERSION=12.4.1
WORKDIR /app
RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM base AS build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LODY_DATA_DIR=/data/lody \
    API_DATA_DIR=/data/api
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data/lody /data/api && chown -R node:node /data
USER node
# Lody credentials, the Loro workspace cache and turn records live here; keep it
# on a persistent volume so restarts neither re-sync everything nor lose turns.
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
