import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";
import debug from "debug";

import { createServer } from "./mcp.js";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import fs from "node:fs";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'static')));

const log = debug("cryo:server");

/**
 * The price of a query in USDC.
 */
const PRICE = 0.05;

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

/**
 * Background cleanup function that removes data folders older than 12 hours
 */
function cleanupOldDataFolders(): void {
    const dataDir = './data';
    const maxAge = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

    try {
        if (!fs.existsSync(dataDir)) {
            return;
        }

        const folders = fs.readdirSync(dataDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        const now = Date.now();
        let removedCount = 0;

        for (const folder of folders) {
            const folderPath = path.join(dataDir, folder);
            try {
                const stats = fs.statSync(folderPath);
                const age = now - stats.mtime.getTime();

                if (age > maxAge) {
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    removedCount++;
                    log(`Removed old data folder: ${folder} (age: ${Math.round(age / (60 * 60 * 1000))}h)`);
                }
            } catch (error) {
                log(`Error checking/removing folder ${folder}:`, error);
            }
        }

        if (removedCount > 0) {
            log(`Cleanup completed: removed ${removedCount} old data folders`);
        }
    } catch (error) {
        log('Error during data folder cleanup:', error);
    }
}

/**
 * Start the background cleanup process
 */
function startBackgroundCleanup(): void {
    // Run cleanup immediately on startup
    cleanupOldDataFolders();

    // Run cleanup every hour (3600000 ms)
    setInterval(cleanupOldDataFolders, 60 * 60 * 1000);

    log('Background data cleanup started (runs every hour)');
}

app.post("/v1/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
        log(`Reusing session id=${sessionId}`);
    } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                transports[sessionId] = transport;
                log(`New session id=${sessionId}`);
            }
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                log(`Session closed id=${transport.sessionId}`);
                const dataDir = path.join('data', transport.sessionId);
                if (fs.existsSync(dataDir)) {
                    fs.rmSync(dataDir, { recursive: true, force: true });
                    log(`Removed data directory for session id=${transport.sessionId}`);
                }
                delete transports[transport.sessionId];
            }
        }

        const server = createServer(PRICE);

        await server.connect(transport);
    } else {
        log(`Invalid request: sessionId=${sessionId}`);
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
            },
        });

        return;
    }

    try {
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        log('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: `Internal server error: ${error}`,
                },
                id: null,
            });
        }
    }
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    log(`Other session request: sessionId=${sessionId}`);
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

app.get('/v1/mcp', handleSessionRequest);

app.delete('/v1/mcp', handleSessionRequest);

// Serve Claude Desktop configuration
app.get('/', (req: Request, res: Response) => {
    const config = {
        "mcpServers": {
            "cryo": {
                "command": "npx",
                "args": [
                    "mcp-remote",
                    "https://cryo-mcp.fly.dev/v1/mcp",
                    "--header",
                    "Authorization: none",
                    "--transport",
                    "http-only"
                ]
            },
            "payflow": {
                "command": "npx",
                "args": ["@chainbound/payflow-mcp"],
                "env": {
                    "PRIVATE_KEY": "",
                    "MAX_PAYMENT_AMOUNT_USDC": "10",
                }
            }
        }
    };

    try {
        // Read the HTML template file
        const htmlTemplate = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

        // Replace the placeholders with actual values
        const html = htmlTemplate
            .replace('{{CONFIG_JSON}}', JSON.stringify(config, null, 2))
            .replace(/\{\{PRICE\}\}/g, PRICE.toString());

        res.send(html);
    } catch (error) {
        log('Error reading HTML template:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Start the server
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

app.listen(PORT, HOST, () => {
    log(`MCP server listening on ${HOST}:${PORT}`);

    // Start background cleanup of old data folders
    startBackgroundCleanup();
});