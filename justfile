default:
    just --list

# Deploy the MCP server to Fly.io after formatting and building
deploy:
    pnpm -r run format
    pnpm -r run build 
    fly deploy --ha=false

# Format all packages in the workspace
format:
    pnpm -r run format

# Build all packages in the workspace
build:
    pnpm -r run build

# Publish all packages in the workspace
publish:
    pnpm -r publish --access public