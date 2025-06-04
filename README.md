# Payflow
> An exploration of agentic commerce with MCP.

## Usage with Claude Desktop
For the purposes of this demo, we'll use the remote and paid [Cryo MCP server](./packages/cryo-mcp), a local [payflow MCP server](./packages/payflow-mcp). The payflow MCP server runs locally and holds the private key for the payer.

1. Press `cmd+,` in Claude Desktop to open the settings
2. Go to the `Developer` tab
3. Click edit config and open the `claude_desktop_config.json` file
4. Add the `cryo` server to the `mcpServers` object:
5. Add the `payflow` server to the `mcpServers` object, with the correct configuration:
```json
{
  "globalShortcut": "",
  "mcpServers": {
    "cryo": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://cryo-mcp.fly.dev/v1/mcp",
        "--header",
        "Authorization: test",
        "--transport",
        "http-only"
      ]
    },
    "payflow": {
      "command": "npx",
      "args": ["@chainbound/payflow-mcp"],
      "env": {
        "PRIVATE_KEY": "",
        // Set your max payment amount in USDC per tool call
        "MAX_PAYMENT_AMOUNT_USDC": "10",
        // Enable debug logging
        "DEBUG": "payflow:*"
      }
    }
  }
}
```

## Testing
```bash
pnpm dev
npx @modelcontextprotocol/inspector
```

## Development
Run the following command in the `packages/payments-mcp` directory:
```bash
pnpm build
pnpm link
```
You'll now be able to run `payments-mcp` anywhere (e.g. in Claude Desktop MCP).
Make sure to run `pnpm build` in the `packages/payments-mcp` directory after making changes.

## Deploy
```bash
# Set secrets
cat .env | fly secrets import
# No HA, otherwise we get inconsistent sessions
fly deploy --ha=false
```