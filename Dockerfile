# Forge Intelligence — container image for Coolify / DigitalOcean.
#
# Why a Dockerfile instead of nixpacks (added 2026-08-16 during the Render -> DO migration):
#
#   `rolldown@1.1.3` (pulled in by vite ^8) declares `engines.node: ^20.19.0 || >=22.12.0`.
#   Nixpacks' Node 22 resolves to **22.11.0** — one patch below that floor — so npm skips
#   rolldown's platform-specific optional dependency and the build dies with the misleading
#   "Cannot find native binding" error (npm/cli#4828). Nixpacks' pinned nixpkgs snapshot has
#   no Node 24 to escape to.
#
#   The repo declares no `engines` field, so nothing recorded that floor anywhere. This image
#   pins it explicitly. If you bump vite/rolldown, check their engines before changing the tag.
#
# Build context note: `npm ci` is used here (not `npm install`, and not the `yarn install`
# the old Render service ran against a repo that has no yarn.lock — that combination silently
# ignored package-lock.json and resolved fresh on every build).

FROM node:22.12-bookworm-slim

WORKDIR /app

# System deps: the app shells out for image/media work and needs CA certs for outbound TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Dependency layer — cached unless the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci

# Application source, then the vite build (emits ./dist, which server.js serves).
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# dumb-init so SIGTERM reaches node and the container stops cleanly on redeploy.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
