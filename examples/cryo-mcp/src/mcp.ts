import { PayflowMcpServer } from "@chainbound/payflow-sdk";
import { z } from "zod";
import { hexToBytes, isAddress, isHash } from "viem";
import debug from "debug";
import path from "node:path";
import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";

import { FourByteHandler } from "./handlers/4byte.js";
import { CryoHandler } from "./handlers/cryo.js";
import pkg from "../package.json" with { type: "json" };

const log = debug("cryo:mcp");

const PRICE = 0.01;

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

const RANGE_DESCRIPTION = `
Block specification syntax
- can use numbers                    --blocks 5000 6000 7000
- can use ranges                     --blocks 12M:13M 15M:16M
- numbers can contain { _ . K M B }  5_000 5K 15M 15.5M
- omitting range end means latest    15.5M: == 15.5M:latest
- omitting range start means 0       :700 == 0:700
- minus on start means minus end     -1000:7000 == 6000:7000
- plus sign on end means plus start  15M:+1000 == 15M:15.001K
- can use every nth value            2000:5000:1000 == 2000 3000 4000
- can use n values total             100:200/5 == 100 124 149 174 199`

const QUERY_DATASET_DESCRIPTION = `
Query a specific cryo dataset for Ethereum data and returns the file path to the resulting Parquet file. This Parquet file can be used to run SQL queries against
using other tools. Binary columns (like transaction hashes, addresses, calldata) are encoded and stored as 0x-prefixed hex strings.
`

const RPC_URL = process.env.RPC_URL!;

export const createServer = () => {
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

    server.paidTool("query_dataset", QUERY_DATASET_DESCRIPTION, {
        price: PRICE,
        recipient: RECIPIENT,
    }, {
        name: z.string().describe("The name of the dataset to query"),
        range: z.string().refine(isBlockRange, { message: "Invalid block range" }).optional().describe(`The range of blocks to query. ${RANGE_DESCRIPTION}`),
        address: z.string().refine(isAddress, { message: "Invalid address" }).optional().describe("The address to query"),
        transactionHashes: z.array(z.string().refine(isHash, { message: "Invalid transaction hash" })).optional().describe("The transaction hashes to query"),
        fromAddress: z.string().refine(isAddress, { message: "Invalid address" }).optional().describe("The sender of the transaction to query"),
        toAddress: z.string().refine(isAddress, { message: "Invalid address" }).optional().describe("The receiver of the transaction to query"),
    }, async ({ name, range, address, transactionHashes, fromAddress, toAddress }, { sessionId }) => {
        const cryo = new CryoHandler(RPC_URL);
        const outputDir = `data/${sessionId!}`;
        const result = await cryo.queryDataset(name, range, address, transactionHashes, fromAddress, toAddress, outputDir);
        log(`Queried dataset rows=${result.rows} sessionId=${sessionId}`);
        log(`Settling payment... sessionId=${sessionId}`);

        const fileNames = result.files.map(file => path.basename(file));

        return {
            content: [{
                type: "text",
                text: JSON.stringify(fileNames),
            }],
        }
    });

    server.tool("query_sql", "Run a DuckDB SQL query against a parquet file. Don't limit the query by default, only if necessary.", {
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

    server.tool("translate_event_signature", "Translates a hexadecimal event signature into a human readable event name.", {
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
// - omitting range end means latest    15.5M: == 15.5M:latest
// - omitting range start means 0       :700 == 0:700
// - minus on start means minus end     -1000:7000 == 6000:7000
// - plus sign on end means plus start  15M:+1000 == 15M:15.001K
// - can use every nth value            2000:5000:1000 == 2000 3000 4000
// - can use n values total             100:200/5 == 100 124 149 174 199`
function isBlockRange(value: string): boolean {
    // TODO: implement
    return true;
}