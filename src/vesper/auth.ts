/**
 * Vesper authentication.
 *
 * A shared secret in a file only the user can read. This is not a substitute
 * for OS access control and is not claimed to be: anything already running as
 * this user can read the token. Its job is narrower and still worth doing —
 * it stops an unrelated local process from stumbling onto the endpoint and
 * driving NEXUS by accident, and it gives the audit trail something concrete
 * to record about who connected.
 *
 * Comparison is constant time so a wrong token cannot be discovered a
 * character at a time.
 */

import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import { atomicWrite, pathExists, readText } from '../core/fsx.js';
import type { IdSource } from '../core/ids.js';
import type { NexusPaths } from '../core/paths.js';
import { registerSecret } from '../core/redact.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

export const TOKEN_FILENAME = 'vesper-token';

export function tokenFile(paths: NexusPaths): string {
  return path.join(paths.runtime, TOKEN_FILENAME);
}

/**
 * Load the token, creating one on first use. The file is written 0600; on
 * Windows the containing directory is under the user's LOCALAPPDATA, which is
 * not readable by other users by default.
 */
export async function ensureToken(paths: NexusPaths, ids: IdSource): Promise<Result<string, NexusError>> {
  const file = tokenFile(paths);
  if (await pathExists(file)) {
    const existing = await readText(file);
    if (!existing.ok) return err(existing.error);
    const token = existing.value.trim();
    if (token.length < 32) {
      return err(nexusError('E_STATE', 'the Vesper token file is too short to be a valid token; delete it to regenerate'));
    }
    registerSecret(token);
    return ok(token);
  }

  const token = ids.secret(32);
  const written = await atomicWrite(file, `${token}\n`, { fsyncData: true, mode: 0o600 });
  if (!written.ok) return err(written.error);
  registerSecret(token);
  return ok(token);
}

/** Constant-time token comparison. */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so the failure path costs the same either way.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class ScopeSet {
  private readonly granted: ReadonlySet<string>;

  constructor(scopes: readonly string[]) {
    this.granted = new Set(scopes);
  }

  has(scope: string): boolean {
    return this.granted.has(scope);
  }

  list(): readonly string[] {
    return [...this.granted].sort();
  }
}
