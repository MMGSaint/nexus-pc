/**
 * Identifier generation. Injectable so tests produce stable ids.
 */

import { randomUUID, randomBytes } from 'node:crypto';

export interface IdSource {
  /** Opaque unique id with a short human-recognisable prefix. */
  next(prefix: string): string;
  /** High-entropy secret suitable for the Vesper auth token. */
  secret(bytes?: number): string;
}

export const systemIds: IdSource = {
  next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
  secret: (bytes = 32) => randomBytes(bytes).toString('base64url'),
};

/** Deterministic id source for tests. */
export class SequentialIds implements IdSource {
  private counter = 0;

  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter.toString().padStart(8, '0')}`;
  }

  secret(bytes = 32): string {
    this.counter += 1;
    return `test-secret-${this.counter}`.padEnd(bytes, 'x');
  }
}
