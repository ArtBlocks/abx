# ABX Self-Host Toolkit — e2e/test build harness.
#
# NOTE: this is the workspace-copy image used by `scripts/e2e-remote-resolver.sh`
# (`docker build .`) to stand up a separate resolver process for the remote
# add/index/migrate tests. It is NOT the artifact end users deploy — that one is
# npm-based and emitted by `abx deploy-resolver`.
#
# The whole self-host stack in one small image: Node 24 (for the built-in
# node:sqlite projection store) + pnpm via corepack. No native modules, no
# Postgres, no build step — it runs the TypeScript directly with tsx, exactly
# like `pnpm abx` does locally.
FROM node:24-slim

# pnpm comes bundled with Node via corepack; pin to the workspace's version.
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# Install deps first so this layer caches across source changes. Every workspace
# package.json globbed by pnpm-workspace.yaml MUST be copied here — list all six.
# Trap: if one is omitted, `pnpm install --frozen-lockfile` does NOT fail (it still
# symlinks the package optimistically), but that package's node_modules is never
# created. The image builds and "deploys", then crashes at runtime the moment its
# source imports a real dep (e.g. storage → `viem`). Keep this list in sync with
# pnpm-workspace.yaml: sdk + {cli,indexer,storage,token-api}.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/indexer/package.json packages/indexer/
COPY packages/storage/package.json packages/storage/
COPY packages/token-api/package.json packages/token-api/
COPY packages/effects/package.json packages/effects/
RUN pnpm install --frozen-lockfile

# Source (the SDK ships committed ABIs, so neither contracts/ nor forge is needed).
COPY packages/ packages/

# The disposable, replay-rebuildable projection (SQLite) lives here — mount a
# volume to persist it across restarts; delete it and `abx index` to rebuild.
ENV ABX_DATA_DIR=/data \
    ABX_PORT=8787 \
    ABX_CHAIN=sepolia
VOLUME /data
EXPOSE 8787

# Serve the token API + dashboard from the reconstructed projection.
# Deploy/index a project with:  docker compose run --rm abx-self-host pnpm abx demo
CMD ["pnpm", "abx", "serve"]
