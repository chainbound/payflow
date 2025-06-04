import debug from 'debug';
import { URL } from 'node:url';

export class FourByteHandler {
  private readonly endpoint: URL;
  private readonly log: debug.Debugger;

  constructor(endpoint: string) {
    this.endpoint = new URL(endpoint);
    this.log = debug('cryo:handlers:4byte');
  }

  async getEvent(signature: string): Promise<string[]> {
    const uri = this.endpoint;
    uri.searchParams.set('hex_signature', signature);

    this.log(`Fetching event signature=${signature} uri=${uri.toString()}`);
    const response = await fetch(uri.toString());

    if (!response.ok) {
      throw new Error(
        `Failed to fetch event signature=${signature} status=${response.status} body=${await response.text()}`
      );
    }

    const data = await response.json();
    return data.results.map((result: { text_signature: string }) => result.text_signature);
  }
}
