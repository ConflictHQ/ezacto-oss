# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install --no-install-recommends --yes g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, source second, and the order is the whole point.
#
# `COPY . .` sat above `npm ci`, so every source edit invalidated the
# dependency layer and the full workspace install -- wrangler and esbuild
# included -- ran again on a build that had changed one line of TypeScript. The
# job grew to 20m18s against a 20-minute ceiling, GitHub cancelled it, a
# cancelled job fails the run, and `deploy` runs only after `verify`: three
# production deployments were skipped by a build that was merely slow (issue
# 529).
#
# A workspace install needs every workspace's manifest present to resolve the
# tree, so they are copied as manifests rather than as whole packages. This
# layer now changes only when a package.json or the lockfile does.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY entries/container/package.json ./entries/container/
COPY entries/worker/package.json ./entries/worker/
COPY packages/api/package.json ./packages/api/
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/mailer/package.json ./packages/mailer/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/migrate/package.json ./packages/migrate/

# `--ignore-scripts` so a prepare hook cannot run before the source it builds
# is present. The build steps below run explicitly.
RUN npm ci --include=dev --ignore-scripts

COPY . .

RUN npm run build -w @ezacto/web \
  && npm run build -w ezacto-container \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    EZACTO_DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/entries/container/dist ./entries/container/dist

RUN install -d -o node -g node -m 0700 /data
USER node

VOLUME ["/data"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "entries/container/dist/index.js"]
