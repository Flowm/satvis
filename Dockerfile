# satvis — Satellite orbit visualization
#
# Builds the Vue 3 + Vite + CesiumJS frontend and serves the static bundle.
# The app self-hosts: with no backend it falls back to the committed
# `data/gp/` snapshot, so the globe and satellite lists render in the
# container without a Cloudflare Worker running. Point the GraphQL/REST
# worker at BASE_URL when one is available.

FROM node:24-bookworm AS build
WORKDIR /app

# Toolchain. pnpm via corepack; GDAL-free path (the offline base map is
# optional and generated separately with docker, not required to run the app).
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies (pnpm workspace: frontend + satvis-worker).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY worker/package.json ./worker/package.json
RUN pnpm install --frozen-lockfile

# Build the frontend bundle into dist/public.
COPY . .
RUN pnpm build

# Serve the static build with a tiny zero-dep Node server.
FROM node:24-bookworm AS serve
WORKDIR /app
COPY --from=build /app/dist/public /app/dist/public
RUN npm init -y >/dev/null 2>&1 && npm pkg set type=module >/dev/null 2>&1

# SPA fallback: unknown non-asset paths return index.html so client routing works.
RUN printf '%s' \
'import {createServer} from "node:http";import {readFile,stat} from "node:fs/promises";import {extname,join,normalize} from "node:path";const ROOT="/app/dist/public";const TYPES={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml",".png":"image/png",".webp":"image/webp",".woff2":"font/woff2",".glb":"model/gltf-binary"};createServer(async(rq,rs)=>{try{let p=decodeURIComponent(new URL(rq.url,"http://x").pathname);let fp=join(ROOT,normalize(p));try{const s=await stat(fp);if(s.isDirectory())fp=join(fp,"index.html");}catch{if(!extname(fp))fp=join(ROOT,"index.html");}const body=await readFile(fp);rs.writeHead(200,{"content-type":TYPES[extname(fp)]||"application/octet-stream"});rs.end(body);}catch{rs.writeHead(404,{"content-type":"text/html"});rs.end("<h1>Not Found</h1>");}}).listen(8080,()=>console.log("satvis on http://0.0.0.0:8080"));' > server.mjs

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
