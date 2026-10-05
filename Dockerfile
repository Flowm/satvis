# Self-hosted satvis: the static app and the GP Worker in one container, the
# Worker running on workerd through wrangler's local runtime (worker/scripts/serve.mjs).
#
#   docker build --build-arg BUILD_SHA=$(git rev-parse --short HEAD) -t satvis .
#   docker run -p 8080:8080 -v satvis-data:/data -e REFRESH_TOKEN=... satvis
#
# The build takes whatever data/ holds: run `git submodule update --init` for the
# 3D models and `pnpm update-imagery` for base-map levels 3-5 first. Private
# plugins under data/custom/ are built in too, so an image built from a checkout
# that has them must not be pushed anywhere public.

# Debian rather than Alpine: workerd links against glibc.
FROM node:24-bookworm-slim AS deps
RUN npm install --global corepack@latest && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json worker/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Baked into the bundle. The committed ion token only works on satvis.space, so
# terrain and the surface models need an unrestricted one on any other host.
ARG VITE_CESIUM_ION_TOKEN=""
ARG VITE_POSTHOG_KEY=""
# .git is not in the context; this is what PostHog events carry as build_sha.
ARG BUILD_SHA=""
RUN pnpm --filter satvis-worker generate-groups && pnpm build

# Only wrangler, at the locked version, which pins miniflare and workerd exactly.
# A filtered pnpm install would also pull in the frontend's dependencies.
FROM node:24-bookworm-slim AS runtime-deps
WORKDIR /app
COPY --from=deps /app/worker/node_modules/wrangler/package.json /tmp/wrangler.json
RUN npm install --omit=dev --no-save --no-fund --no-audit "wrangler@$(node -p "require('/tmp/wrangler.json').version")"

FROM node:24-bookworm-slim
# workerd verifies TLS against the system store, which slim images leave empty.
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=runtime-deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --chown=node:node worker/wrangler.jsonc worker/tsconfig.json worker/
COPY --chown=node:node worker/src worker/src
COPY --chown=node:node worker/scripts/serve.mjs worker/scripts/
COPY --from=build --chown=node:node /app/worker/src/config/satvis.generated.json worker/src/config/
RUN mkdir /data && chown node:node /data worker
USER node
ENV HOME=/tmp \
  WRANGLER_SEND_METRICS=false \
  CLOUDFLARE_CF_FETCH_ENABLED=false
VOLUME /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/groups.json').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "worker/scripts/serve.mjs"]
