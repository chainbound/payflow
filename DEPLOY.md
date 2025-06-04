# Deploying the MCP server

This repo contains configuration for deploying the MCP server to Fly.io.

## Initial Setup
```bash
# Run through the interactive setup, make sure to copy over the existing fly.toml
fly launch --copy-config
# Import secrets
cat .env | fly secrets import
```

## Deploy
```bash
# Will run build and format, and `fly deploy --ha=false`
# No HA because we'll get inconsistent sessions
just deploy
```

## Troubleshooting
```bash
# Check the logs
fly logs --app cryo-mcp
```