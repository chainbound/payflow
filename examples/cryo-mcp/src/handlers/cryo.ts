import { spawn } from 'child_process';
import fs from 'node:fs';
import debug from 'debug';

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
      const command = `cryo ${args.join(' ')}`;
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
          reject(msg);
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
    outputDir: string = 'data'
  ): Promise<CryoResult> {
    const args = [
      name,
      '--rpc',
      this.rpc,
      '--hex', // Use hex string encoding for binary columns
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

    let stdout = await this.spawn(args);
    return {
      files: extractOutputFile(outputDir, stdout),
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
function extractOutputFile(outputDir: string, stdout: string): string[] {
  // Extract the report file path from stdout
  const match = stdout.match(/- report file:\s*(.+\.json)/);
  if (!match) {
    throw new Error('No report file found in stdout');
  }

  // Replace $OUTPUT_DIR with the actual output directory
  const reportFilePath = match[1].replace('$OUTPUT_DIR', outputDir);

  try {
    // Read and parse the JSON report file
    const reportContent = fs.readFileSync(reportFilePath, 'utf8');
    const report = JSON.parse(reportContent);

    // Extract the first completed path
    const completedPaths = report.results?.completed_paths;
    if (!completedPaths || completedPaths.length === 0) {
      throw new Error('No completed paths found in report');
    }

    return completedPaths;
  } catch (error) {
    throw new Error(`Failed to read report file ${reportFilePath}: ${error}`);
  }
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
