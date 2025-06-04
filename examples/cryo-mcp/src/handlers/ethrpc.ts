import { spawn } from 'child_process';
import debug from 'debug';
import { createPublicClient, http, type PublicClient } from 'viem';

export class EthRpcHandler {
  private readonly client: PublicClient;
  private readonly log: debug.Debugger;

  constructor(rpc: string) {
    this.client = createPublicClient({
      transport: http(rpc),
    });

    this.log = debug('cryo:handlers:ethrpc');
  }

  /**
   * Get the latest block number.
   *
   * @returns The latest block number.
   */
  async getLatestBlockNumber(): Promise<bigint> {
    return await this.client.getBlockNumber();
  }
}
