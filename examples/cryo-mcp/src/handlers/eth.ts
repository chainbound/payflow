import debug from 'debug';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';

export class EthHandler {
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
    this.log('getLatestBlockNumber');
    return await this.client.getBlockNumber();
  }

  /**
   * Resolve an ENS name to an address.
   *
   * @param name - The ENS name to resolve.
   * @returns The address of the ENS name.
   */
  async resolveEns(name: string): Promise<Address | null> {
    this.log('resolveEns', name);
    return await this.client.getEnsAddress({ name });
  }

  /**
   * Get the ENS name for an address.
   *
   * @param address - The address to get the ENS name for.
   * @returns The ENS name for the address.
   */
  async getEnsName(address: Address): Promise<string | null> {
    this.log('getEnsName', address);
    return await this.client.getEnsName({ address });
  }
}
