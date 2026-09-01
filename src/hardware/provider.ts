/**
 * Hardware provider interface.
 *
 * A provider knows how to interrogate one kind of host: real Windows, real
 * Linux (development only), or a fixture file. Providers carry a trust level
 * that flows into every artifact they produce, so a fixture-derived inventory
 * is labelled `mocked` all the way out to the Vesper boundary.
 */

import type { Clock } from '../core/clock.js';
import type { CommandRunner } from '../core/exec.js';
import type { NexusError } from '../core/errors.js';
import type { Fidelity } from '../core/fidelity.js';
import type { Logger } from '../core/logger.js';
import type { Result } from '../core/result.js';
import type { HardwareInventory } from '../domain/hardware.js';

export interface DiscoveryContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runner: CommandRunner;
  readonly platform: NodeJS.Platform;
  readonly timeoutMs: number;
}

export interface HardwareProvider {
  readonly id: string;
  /** Provenance of everything this provider produces. */
  readonly trust: Fidelity;
  /** Whether this provider can run on the given platform. */
  supports(platform: NodeJS.Platform): boolean;
  discover(context: DiscoveryContext): Promise<Result<HardwareInventory, NexusError>>;
}

export function hashMachineIdentifier(raw: string | null): string | null {
  if (!raw) return null;
  // Stored as a hash so a machine can be recognised across sessions without
  // the identifier itself ever being written to disk or sent to Vesper.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (((h2 >>> 0) * 4294967296 + (h1 >>> 0)) >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0');
}
