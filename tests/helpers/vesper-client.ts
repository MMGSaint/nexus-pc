import net from 'node:net';

import { VESPER_CONTRACT_VERSION } from '../../src/vesper/contract.js';
import type { VesperResponse } from '../../src/vesper/contract.js';

/** Minimal newline-delimited JSON client, as Vesper itself would implement. */
export class TestVesperClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private readonly pending: ((response: VesperResponse) => void)[] = [];

  async connect(endpoint: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: endpoint });
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        this.socket = socket;
        resolve();
      });
      socket.once('error', reject);
      socket.on('data', (chunk: string) => {
        this.buffer += chunk;
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          const resolver = this.pending.shift();
          if (resolver && line.trim() !== '') resolver(JSON.parse(line) as VesperResponse);
          index = this.buffer.indexOf('\n');
        }
      });
    });
  }

  /** Send a well-formed request. */
  async call(
    method: string,
    token: string,
    params?: Record<string, unknown>,
    version = VESPER_CONTRACT_VERSION,
  ): Promise<VesperResponse> {
    return this.sendRaw(
      JSON.stringify({ v: version, id: `req-${method}`, method, token, ...(params ? { params } : {}) }),
    );
  }

  /** Send arbitrary bytes, for malformed-input tests. */
  async sendRaw(payload: string): Promise<VesperResponse> {
    const socket = this.socket;
    if (!socket) throw new Error('not connected');
    return new Promise<VesperResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 5000);
      this.pending.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
      socket.write(`${payload}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
