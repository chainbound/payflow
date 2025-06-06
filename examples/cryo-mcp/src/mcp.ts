import { z } from "zod";
import { hexToBytes, isAddress, isHash } from "viem";
import debug from "debug";
import path from "node:path";
import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

import { PayflowMcpServer } from "@chainbound/payflow-sdk";
import { FourByteHandler } from "./handlers/4byte.js";
import { CryoHandler } from "./handlers/cryo.js";
import pkg from "../package.json" with { type: "json" };
import { EthHandler } from "./handlers/eth.js";
import { EtherscanHandler } from "./handlers/etherscan.js";

const log = debug("cryo:mcp");

/**
 * The maximum aggregated blocks per query.
 */
const MAX_BLOCK_RANGE_PER_QUERY = 10000;

// Get the recipient from the environment variables
const RECIPIENT = process.env.PAYFLOW_RECIPIENT!;
if (!RECIPIENT) {
    throw new Error("PAYFLOW_RECIPIENT is not set");
}

if (!process.env.CDP_API_KEY_ID) {
    throw new Error("CDP_API_KEY_ID is not set");
}

if (!process.env.CDP_API_KEY_SECRET) {
    throw new Error("CDP_API_KEY_SECRET is not set");
}

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
if (!ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is not set");
}

const RANGE_DESCRIPTION = `
Block specification syntax
- can use numbers                    5000 6000 7000
- can use ranges                     12M:13M 15M:16M
- numbers can contain { _ . K M B }  5_000 5K 15M 15.5M
- omitting range start means 0       :700 == 0:700
- minus on start means minus end     -1000:7000 == 6000:7000
- plus sign on end means plus start  15M:+1000 == 15M:15.001K
- can use every nth value            2000:5000:1000 == 2000 3000 4000
- can use n values total             100:200/5 == 100 124 149 174 199`

const FETCH_ABI_DESCRIPTION = `
Fetch the ABI for a given contract. The ABI is useful to understand the contract interface with its functions and events.

Returns:
The ABI of the contract in JSON (if it exists).

Use when:
- You need to understand the contract interface with its functions and events and present that data to the user.
- The user asks you to do a deep dive into a specific contract and you need to understand the contract interface.
- You use the 'query_dataset' tool with the 'eventSignature' parameter and you need to understand the event signature.
`

const QUERY_DATASET_DESCRIPTION = `
Query a specific cryo dataset for Ethereum data.

Returns:
The file path to the resulting Parquet file. This Parquet file can be queried using the 'query_sql' tool with DuckDB SQL.

Use when:
- You need to query Ethereum data to present to the user.

Guidelines:
- For recent data queries, always use the 'get_latest_block_number' tool first to get the latest block number.
- The maximum number of blocks that can be queried at once is ${MAX_BLOCK_RANGE_PER_QUERY}. If you need to query more blocks, you have to query the data in smaller chunks.
- If the user doesn't explicitly specify a range, use the last ${MAX_BLOCK_RANGE_PER_QUERY} blocks.
- If the user asks for events / logs, use the 'eventSignature' parameter to filter for the event signature after fetching the ABI with the 'fetch_abi' tool.
- Use the 'help' and 'list_datasets', and 'describe_dataset' tools FIRST to get more information about the datasets and how to query them.
- After running this tool, you can use the 'query_sql' tool to run SQL queries against the resulting Parquet file.
`

const QUERY_SQL_DESCRIPTION = `
Run a DuckDB SQL query against a parquet file obtained from the 'query_dataset' tool.

Returns:
The result of the query.

Guidelines:
- Always use the table name 'data' to query the data.
- Don't limit the query by default, only if necessary.
- All binary columns (like transaction hashes, addresses, calldata) are encoded and stored as 0x-prefixed hex strings in the tables.
`

const TRANSLATE_EVENT_SIGNATURE_DESCRIPTION = `
Translates a hexadecimal event signature into a human readable event name. This is useful to get the event name from the event signature.

Returns:
The human readable event name. 

Use when:
- You need to translate a hexadecimal event signature into a human readable event name to present to the user.
`

const RPC_URL = process.env.RPC_URL!;

export const createServer = (price: number) => {
    const server = new PayflowMcpServer({
        name: pkg.name,
        version: pkg.version,
    }, {
        capabilities: {
            resources: {
                subscribe: true,
                listChanged: true,
            }
        },
        x402: {
            version: 1,
            keyId: process.env.CDP_API_KEY_ID,
            keySecret: process.env.CDP_API_KEY_SECRET,
        }
    })


    server.tool("help", "Get help for cryo.", async () => {
        const cryo = new CryoHandler(RPC_URL);
        const help = await cryo.help();

        return {
            content: [{
                type: "text",
                text: help,
            }],
        }
    });

    server.tool("list_datasets", "List all the available cryo datasets to query.", async () => {
        const cryo = new CryoHandler(RPC_URL);
        const datasets = await cryo.listDatasets();

        return {
            content: [{
                type: "text",
                text: datasets,
            }],
        }
    })

    server.tool("get_latest_block_number", "Get the latest block number. Always use this tool to get the latest block number for recent data queries.", async () => {
        const ethrpc = new EthHandler(RPC_URL);
        const blockNumber = await ethrpc.getLatestBlockNumber();
        return {
            content: [{
                type: "text",
                text: blockNumber.toString(),
            }],
        }
    })

    server.tool("describe_dataset", "Describe a specific cryo dataset.", {
        name: z.string().describe("The name of the dataset to describe"),
    }, async ({ name }) => {
        const cryo = new CryoHandler(RPC_URL);
        const description = await cryo.describeDataset(name);

        return {
            content: [{
                type: "text",
                text: description,
            }],
        }
    })

    server.tool("fetch_abi", FETCH_ABI_DESCRIPTION, {
        address: z.string().refine(isAddress, { message: "Invalid address" }).describe("The address of the contract to fetch the ABI for"),
    }, async ({ address }) => {
        const etherscan = new EtherscanHandler(ETHERSCAN_API_KEY);
        const abi = await etherscan.getAbi(address);
        return {
            content: [{
                type: "text",
                text: abi,
            }],
        }
    })

    server.paidTool("query_dataset", QUERY_DATASET_DESCRIPTION, {
        price: price,
        recipient: RECIPIENT,
    }, {
        name: z.string().describe("The name of the dataset to query"),
        range: z.string().refine(isBlockRange, { message: "Invalid block range" }).optional().describe(`The range of blocks to query. ${RANGE_DESCRIPTION}`),
        address: z.string().refine(isAddress, { message: "Invalid address" }).optional().describe("The address to query"),
        transactionHashes: z.array(z.string().refine(isHash, { message: "Invalid transaction hash" })).optional().describe("The transaction hashes to query"),
        fromAddress: z.string().refine(isAddress, { message: "Invalid address" }).optional().describe("The sender of the transaction to query"),
        toAddress: z.string().refine(isAddress, { message: "Invalid address" }).optional().describe("The receiver of the transaction to query"),
        eventSignature: z.string().refine(isValidEventSignatureString, { message: "Invalid event signature. Needs to be the full signature, like: PairCreated(address indexed token0, address indexed token1, address pair, uint) or PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool). If you don't have this, use the fetch_abi tool." }).optional().describe("The event signature to filter for."),
    }, async ({ name, range, address, transactionHashes, fromAddress, toAddress, eventSignature }, { sessionId }) => {
        // Rate limiting: check block count if range is specified
        if (range) {
            try {
                const blockCount = calculateBlockCount(range);
                log(`Block count for range "${range}": ${blockCount} blocks`);

                if (blockCount > MAX_BLOCK_RANGE_PER_QUERY + 1) {
                    throw new Error(`Query would process ${blockCount} blocks, which exceeds the maximum of ${MAX_BLOCK_RANGE_PER_QUERY} blocks per query. Please reduce the range or use more specific filters.`);
                }
            } catch (error) {
                throw new Error(`Invalid block range: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (transactionHashes) {
            if (transactionHashes.length > MAX_BLOCK_RANGE_PER_QUERY) {
                throw new Error(`You can only query up to ${MAX_BLOCK_RANGE_PER_QUERY} transaction hashes at once.`);
            }
        }

        if (!range && !transactionHashes) {
            throw new Error("Either range or transactionHashes must be specified");
        }

        const cryo = new CryoHandler(RPC_URL);
        const outputDir = `data/${sessionId!}`;
        const result = await cryo.queryDataset(name, range, address, transactionHashes, fromAddress, toAddress, eventSignature, outputDir);

        const fileNames = result.files.map(file => path.basename(file));
        log(`Queried dataset rows=${result.rows} sessionId=${sessionId} files=${fileNames.join(', ')}`);

        return {
            content: [{
                type: "text",
                text: fileNames.length > 0 ? JSON.stringify(fileNames) : "No output files were generated.",
            }],
        }
    });

    server.tool("describe_table", "Describe the table in the Parquet file. This is useful to understand the schema of the table.", {
        file: z.string().describe("The parquet file to describe."),
    }, async ({ file }, { sessionId }) => {
        log(`Describing table file=${file} sessionId=${sessionId}`);
        const instance = await DuckDBInstance.create(":memory:");
        const duckdb = await instance.connect();

        if (file.includes('/') || file.includes('\\')) {
            throw new Error('Invalid file');
        }

        if (!file.endsWith('.parquet')) {
            throw new Error('File must be a parquet file');
        }

        const parquetFile = path.join("data", sessionId!, file);

        if (!existsSync(parquetFile)) {
            throw new Error(`File not found: ${file}`);
        }

        const reader = await duckdb.runAndReadAll(`DESCRIBE SELECT * FROM '${parquetFile}';`);
        const rows = reader.getRowObjectsJson();

        duckdb.closeSync();

        return {
            content: [{
                type: "text",
                text: JSON.stringify(rows, null, 2),
            }],
        }
    })

    server.tool("query_sql", QUERY_SQL_DESCRIPTION, {
        query: z.string().describe("The query to execute against the data. Always use the table name 'data' to query the data."),
        file: z.string().describe("The parquet file to query."),
    }, async ({ query, file }, { sessionId }) => {
        log(`Querying SQL query=${query} file=${file} sessionId=${sessionId}`);

        const instance = await DuckDBInstance.create(":memory:");
        const duckdb = await instance.connect();

        if (file.includes('/') || file.includes('\\')) {
            throw new Error('Invalid file');
        }

        if (!file.endsWith('.parquet')) {
            throw new Error('File must be a parquet file');
        }

        // Get the parquet file path from the result resource
        const parquetFile = path.join("data", sessionId!, file);

        if (!existsSync(parquetFile)) {
            throw new Error(`File not found: ${file}`);
        }

        await duckdb.run(`CREATE TABLE data AS SELECT * FROM parquet_scan('${parquetFile}');`);

        const reader = await duckdb.runAndReadAll(query);
        const rows = reader.getRowObjectsJson();
        log(`Query result rows=${rows.length} sessionId=${sessionId}`);

        duckdb.closeSync();

        return {
            content: [{
                type: "text",
                text: JSON.stringify(rows, null, 2),
            }],
        }
    })

    server.tool("translate_event_signature", TRANSLATE_EVENT_SIGNATURE_DESCRIPTION, {
        signature: z.string().describe("The first 4 bytes of the hexadecimal event signature to translate.").refine(isSignature, { message: "Invalid signature" }),
    }, async ({ signature }) => {
        const fb = new FourByteHandler("https://www.4byte.directory/api/v1/event-signatures/");
        try {
            const event = await fb.getEvent(signature);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(event),
                }],
            }
        } catch (error) {
            log(`Error translating event signature=${signature} error=${error}`);
            throw error;
        }
    })

    return server;
}

function isSignature(value: string): boolean {
    const bytes = hexToBytes(`0x${value.replace('0x', '')}`);
    return bytes.length === 4;
}

// Block specification syntax
// - can use numbers                    --blocks 5000 6000 7000
// - can use ranges                     --blocks 12M:13M 15M:16M
// - numbers can contain { _ . K M B }  5_000 5K 15M 15.5M
// - omitting range start means 0       :700 == 0:700
// - minus on start means minus end     -1000:7000 == 6000:7000
// - plus sign on end means plus start  15M:+1000 == 15M:15.001K
// - can use every nth value            2000:5000:1000 == 2000 3000 4000
// - can use n values total             100:200/5 == 100 124 149 174 199
function isBlockRange(value: string): boolean {
    if (!value || typeof value !== 'string') {
        return false;
    }

    // Split on spaces to handle multiple ranges/numbers
    const parts = value.trim().split(/\s+/);

    if (parts.length === 0) {
        return false;
    }

    return parts.every(part => isValidBlockPart(part));
}

function isValidBlockPart(part: string): boolean {
    // Pattern for a number: optional sign, digits with optional underscores, optional decimal, optional suffix (K/M/B)
    const numberPattern = /^[+-]?[\d_]+(?:\.[\d_]+)?[KMB]?$/;

    // Check if it's just a number
    if (numberPattern.test(part)) {
        return true;
    }

    // Pattern for number component (without leading +/- for ranges)
    const numComponent = /[\d_]+(?:\.[\d_]+)?[KMB]?/;

    // Range patterns
    const patterns = [
        // :number (start from 0)
        new RegExp(`^:${numComponent.source}$`),

        // number:number (basic range)
        new RegExp(`^${numComponent.source}:${numComponent.source}$`),

        // number:+number (plus from start)
        new RegExp(`^${numComponent.source}:\\+${numComponent.source}$`),

        // -number:number (minus from end)
        new RegExp(`^-${numComponent.source}:${numComponent.source}$`),

        // number:number:number (step syntax)
        new RegExp(`^${numComponent.source}:${numComponent.source}:${numComponent.source}$`),

        // number:number/number (division syntax)
        new RegExp(`^${numComponent.source}:${numComponent.source}\\/\\d+$`),
    ];

    return patterns.some(pattern => pattern.test(part));
}

/**
 * Calculate the total number of blocks that would be queried from a block range specification.
 * This is used for rate limiting to ensure queries don't exceed the maximum allowed blocks.
 * 
 * @param blockRange - The block range specification string
 * @returns The total number of blocks that would be queried
 * @throws Error if the range is invalid or contains unsupported syntax
 */
function calculateBlockCount(blockRange: string): number {
    if (!blockRange || typeof blockRange !== 'string') {
        return 0;
    }

    // Split on spaces to handle multiple ranges/numbers
    const parts = blockRange.trim().split(/\s+/);

    if (parts.length === 0) {
        return 0;
    }

    let totalBlocks = 0;

    for (const part of parts) {
        totalBlocks += calculateBlockCountForPart(part);
    }

    return totalBlocks;
}

/**
 * Calculate block count for a single part of the block specification.
 */
function calculateBlockCountForPart(part: string): number {
    // Check if it's just a single number
    if (isSimpleNumber(part)) {
        return 1; // Single block
    }

    // Check for unsupported open-ended ranges
    if (part.endsWith(':')) {
        throw new Error(`Open-ended range "${part}" is not supported. Please specify the end block number.`);
    }

    // Handle division syntax first: X:Y/N means exactly N blocks
    if (part.includes('/')) {
        const match = part.match(/^(.+):(.+)\/(\d+)$/);
        if (match) {
            return parseInt(match[3], 10);
        }
        throw new Error(`Invalid division syntax: "${part}"`);
    }

    // Handle range syntax with colons
    if (part.includes(':')) {
        const colonCount = (part.match(/:/g) || []).length;

        if (colonCount === 2) {
            // Step syntax: X:Y:Z
            const [startStr, endStr, stepStr] = part.split(':');
            const start = parseBlockNumber(startStr);
            const end = parseBlockNumber(endStr);
            const step = parseBlockNumber(stepStr);

            if (start >= end || step <= 0) {
                return 0;
            }

            return Math.floor((end - start) / step) + 1;
        } else if (colonCount === 1) {
            const [startStr, endStr] = part.split(':');

            if (startStr === '') {
                // :Y syntax (start from 0)
                const end = parseBlockNumber(endStr);
                return end + 1; // Blocks 0 to end inclusive
            } else if (endStr === '') {
                // X: syntax (open-ended - not supported)
                throw new Error(`Open-ended range "${part}" is not supported. Please specify the end block number.`);
            } else {
                // X:Y syntax (basic range) or special cases
                if (startStr.startsWith('-')) {
                    // -X:Y syntax (minus from end)
                    const offset = parseBlockNumber(startStr.substring(1));
                    const end = parseBlockNumber(endStr);
                    const start = end - offset;
                    return Math.max(0, end - start + 1);
                } else if (endStr.startsWith('+')) {
                    // X:+Y syntax (plus from start)
                    const blocks = parseBlockNumber(endStr.substring(1));
                    return blocks;
                } else {
                    // Regular X:Y range
                    const start = parseBlockNumber(startStr);
                    const end = parseBlockNumber(endStr);
                    return Math.max(0, end - start + 1);
                }
            }
        }
    }

    // If we get here, it's an invalid format
    throw new Error(`Invalid block range format: "${part}"`);
}

const practicalEventRegex = /^[a-zA-Z_][a-zA-Z0-9_]*\((\s*((address|bool|string|bytes\d{0,2}|u?int\d{0,3})\s*(indexed\s+)?[a-zA-Z_][a-zA-Z0-9_]*(\[\])?)\s*(,\s*((address|bool|string|bytes\d{0,2}|u?int\d{0,3})\s*(indexed\s+)?[a-zA-Z_][a-zA-Z0-9_]*(\[\])?))*\s*)?\)$/;

/**
 * Check if a string is a valid event signature string like:
 * - PairCreated(address indexed token0, address indexed token1, address pair, uint)
 * - PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
 * @param value - The string to check.
 * @returns True if the string is a valid event signature string, false otherwise.
 */
function isValidEventSignatureString(value: string): boolean {
    const normalized = value.trim().replace(/\s+/g, ' ');

    return practicalEventRegex.test(normalized);

}

/**
 * Check if a string represents a simple number (not a range).
 */
function isSimpleNumber(part: string): boolean {
    return /^[+-]?[\d_]+(?:\.[\d_]+)?[KMB]?$/.test(part);
}

/**
 * Parse a block number string that may contain underscores, decimals, and K/M/B suffixes.
 */
function parseBlockNumber(numStr: string): number {
    if (!numStr) {
        return 0;
    }

    // Handle negative numbers
    const isNegative = numStr.startsWith('-');
    const cleanStr = numStr.replace(/^[+-]/, '');

    // Extract suffix
    const suffix = cleanStr.slice(-1);
    let multiplier = 1;
    let numberPart = cleanStr;

    if (suffix === 'K') {
        multiplier = 1000;
        numberPart = cleanStr.slice(0, -1);
    } else if (suffix === 'M') {
        multiplier = 1000000;
        numberPart = cleanStr.slice(0, -1);
    } else if (suffix === 'B') {
        multiplier = 1000000000;
        numberPart = cleanStr.slice(0, -1);
    }

    // Remove underscores and parse
    const cleanNumber = numberPart.replace(/_/g, '');
    const parsed = parseFloat(cleanNumber);

    if (isNaN(parsed)) {
        throw new Error(`Invalid number format: "${numStr}"`);
    }

    const result = Math.floor(parsed * multiplier);
    return isNegative ? -result : result;
}
