import type { Address } from 'viem';

export class EtherscanHandler {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async getAbi(address: Address): Promise<string> {
    const response = await fetch(
      `https://api.etherscan.io/api?module=contract&action=getabi&address=${address.toString()}&apikey=${this.apiKey}`
    );
    const data = await response.json();
    return data.result;
  }
}
