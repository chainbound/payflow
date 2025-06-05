# ---- Build Stage ----
FROM node:22-slim AS build

WORKDIR /app

# Install system dependencies for Rust and build tools
RUN apt-get update && apt-get install -y curl build-essential pkg-config libssl-dev ca-certificates git

# Install Rust and Cargo
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install cryo using Cargo
RUN cargo install --git https://github.com/paradigmxyz/cryo.git --locked

# Copy package files and workspace config
COPY packages/payflow-sdk/tsconfig.json ./packages/payflow-sdk/tsconfig.json
COPY examples/cryo-mcp/tsconfig.json ./examples/cryo-mcp/tsconfig.json
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/payflow-sdk/package.json ./packages/payflow-sdk/package.json
COPY examples/cryo-mcp/package.json ./examples/cryo-mcp/package.json
COPY package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml

RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source files for both packages
COPY packages/payflow-sdk/src ./packages/payflow-sdk/src
COPY examples/cryo-mcp/src ./examples/cryo-mcp/src


COPY packages/payflow-sdk/tsup.config.ts ./packages/payflow-sdk/tsup.config.ts

# Build payflow-sdk first (dependency)
RUN pnpm --filter @chainbound/payflow-sdk run build

# Build cryo-mcp
RUN pnpm --filter @chainbound/cryo-mcp-server run build

# ---- Production Stage ----
FROM node:22-slim AS prod
WORKDIR /app

ENV NODE_ENV=production

# Install system dependencies for cryo
RUN apt-get update && apt-get install -y libssl-dev ca-certificates curl

# Copy cryo binary from build stage
COPY --from=build /root/.cargo/bin/cryo /usr/local/bin/cryo

# Copy workspace configuration and package files
COPY packages/payflow-sdk/package.json ./packages/payflow-sdk/package.json
COPY examples/cryo-mcp/package.json ./examples/cryo-mcp/package.json
COPY package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml
COPY pnpm-workspace.yaml ./pnpm-workspace.yaml

# Install all dependencies (including workspace deps) to ensure proper linking
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy built packages
COPY --from=build /app/packages/payflow-sdk/dist ./packages/payflow-sdk/dist
COPY --from=build /app/examples/cryo-mcp/dist ./examples/cryo-mcp/dist

COPY examples/cryo-mcp/index.html ./examples/cryo-mcp/index.html
COPY examples/cryo-mcp/static ./examples/cryo-mcp/static

# Set working directory to the package
WORKDIR /app/examples/cryo-mcp

RUN useradd -m appuser
USER appuser

EXPOSE 3000
CMD ["node", "dist/index.js"] 