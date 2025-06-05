import { spawn } from 'child_process';
import fs from 'node:fs';
import debug from 'debug';
import path from 'path';

const MAX_ROWS = 10000;

type CryoResult = {
  rows: number;
  files: string[];
};

export class CryoHandler {
  private readonly rpc: string;
  private readonly log: debug.Debugger;

  constructor(rpc: string) {
    this.rpc = rpc;
    this.log = debug('cryo:handlers:cryo');
  }

  async spawn(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const escapedArgs = args.map((arg) => (arg.includes(' ') ? `"${arg.replace(/"/g, '\\"')}"` : arg));
      const command = `cryo ${escapedArgs.join(' ')}`;
      this.log('spawning', command);

      const child = spawn('cryo', args);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          const msg = stderr.trim() || stdout.trim();
          this.log('cryo failed with code', code, 'and message', msg);
          reject(new Error(msg));
        }
      });
    });
  }

  async help(): Promise<string> {
    return this.spawn(['help']);
  }

  /**
   * List all the available cryo datasets to query.
   *
   * @returns The list of datasets.
   */
  async listDatasets(): Promise<string> {
    return this.spawn(['help', 'datasets']);
  }

  /**
   * Describe a specific cryo dataset.
   *
   * @param name - The name of the dataset to describe.
   * @returns The description of the dataset.
   */
  async describeDataset(name: string): Promise<string> {
    return this.spawn(['help', name]);
  }

  /**
   * Query a specific cryo dataset.
   *
   * @param name - The name of the dataset to query.
   * @param range - The range of blocks to query.
   * @param contract - The contract to query.
   * @param includeColumns - The columns to include in the query.
   * @param excludeColumns - The columns to exclude in the query.
   * @returns The file path of the resulting CSV file.
   */
  async queryDataset(
    name: string,
    range?: string,
    address?: string,
    transactionHashes?: string[],
    fromAddress?: string,
    toAddress?: string,
    eventSignature?: string,
    outputDir: string = 'data'
  ): Promise<CryoResult> {
    const args = [
      name,
      '--rpc',
      this.rpc,
      '--hex', // Use hex string encoding for binary columns
      '--overwrite', // We need this so our file extraction works
      '--output-dir',
      outputDir,
      '--chunk-size',
      MAX_ROWS.toString(),
    ];

    if (range) {
      args.push('--blocks', range);
    }

    if (address) {
      args.push('--address', address);
    }

    if (transactionHashes) {
      args.push('--txs', transactionHashes.join(','));
    }

    if (fromAddress) {
      args.push('--from-address', fromAddress);
    }

    if (toAddress) {
      args.push('--to-address', toAddress);
    }

    if (eventSignature) {
      args.push('--event-signature', `${eventSignature}`);
    }

    let stdout;
    try {
      stdout = await this.spawn(args);
    } catch (error) {
      this.log('cryo failed with error', error);
      // NOTE: weird bug with cryo, it will throw an error if no events are found matching the signature and
      // the column type is unsupported: https://github.com/paradigmxyz/cryo/blob/559b65455d7ef6b03e8e9e96a0e50fd4fe8a9c86/crates/to_df/src/lib.rs#L138
      if (eventSignature && error instanceof Error && error.message.includes('could not generate')) {
        return {
          files: [],
          rows: 0,
        };
      }
      throw error;
    }

    return {
      files: extractOutputFile(outputDir),
      rows: extractRowsWritten(stdout) ?? 0,
    };
  }
}

/**
 * Extract the output file path from the stdout of the cryo command. If multiple outputs were generated,
 * return all of them.
 *
 * @param outputDir - The output directory.
 * @param stdout - The stdout of the cryo command.
 * @returns The path to the output file.
 */
function extractOutputFile(outputDir: string): string[] {
  // Find the most recent parquet file in the output directory
  const files = fs
    .readdirSync(outputDir)
    .filter((file) => file.endsWith('.parquet'))
    .map((file) => ({
      name: file,
      path: path.join(outputDir, file),
      time: fs.statSync(path.join(outputDir, file)).mtime,
    }))
    .sort((a, b) => b.time.getTime() - a.time.getTime());

  if (files.length === 0) {
    throw new Error('No parquet files found in output directory');
  }

  return [files[0].path];
}

/**
 * Extract the number of rows written from the stdout of the cryo command.
 *
 * @param stdout - The stdout of the cryo command.
 * @returns The number of rows written.
 */
function extractRowsWritten(stdout: string): number | null {
  const match = stdout.match(/- rows written:\s*([\d,]+)/);
  if (match) {
    // Remove commas from the number and parse as integer
    return parseInt(match[1].replace(/,/g, ''), 10);
  }
  return null;
}
