# One image for the whole demo (setup job, API, web). Node 22 + Foundry + the built monorepo.
FROM ghcr.io/foundry-rs/foundry:v1.5.1 AS foundry

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/anvil /usr/local/bin/cast /usr/local/bin/

WORKDIR /app
# Dependency layer first (cached unless a manifest changes). Install scripts stay disabled (.npmrc).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
# Compile contracts once at build time (solc is cached in the image), generate the Prisma client, build web.
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL=http://127.0.0.1:4600
ARG NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8565
ARG NEXT_PUBLIC_CHAIN_ID=31337
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID
RUN cd packages/contracts && forge build \
  && cd /app/apps/api && npx prisma generate \
  && cd /app && pnpm --filter @fairplay/web build
