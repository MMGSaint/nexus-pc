/**
 * Discovery orchestration.
 *
 * Selects a provider for the host, runs it, and persists the result so that a
 * later session (or a support conversation) can see exactly what NEXUS
 * believed about the machine and when.
 *
 * Failure is a first-class outcome: when no provider can run, discovery
 * returns an inventory-shaped error rather than an empty inventory that looks
 * like a successful read of a bare machine.
 */

import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { CommandRunner } from '../core/exec.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err } from '../core/result.js';
import { writeJson } from '../core/fsx.js';
import type { HardwareInventory } from '../domain/hardware.js';
import { selectPrimaryGpuFromInventory } from './primary-gpu.js';
import type { DiscoveryContext, HardwareProvider } from './provider.js';

export interface DiscoveryOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runner: CommandRunner;
  readonly platform: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly paths?: NexusPaths;
}

export class HardwareDiscovery {
  private readonly providers: HardwareProvider[] = [];

  register(provider: HardwareProvider): void {
    this.providers.push(provider);
  }

  /** Providers that claim support for the platform, in registration order. */
  candidates(platform: NodeJS.Platform): readonly HardwareProvider[] {
    return this.providers.filter((p) => p.supports(platform));
  }

  async discover(options: DiscoveryOptions): Promise<Result<HardwareInventory, NexusError>> {
    const context: DiscoveryContext = {
      clock: options.clock,
      logger: options.logger.child('discovery'),
      runner: options.runner,
      platform: options.platform,
      timeoutMs: options.timeoutMs ?? 20_000,
    };

    const candidates = this.candidates(options.platform);
    if (candidates.length === 0) {
      return err(
        nexusError('E_UNSUPPORTED', `no hardware provider supports platform "${options.platform}"`, {
          platform: options.platform,
          registered: this.providers.map((p) => p.id),
        }),
      );
    }

    const failures: string[] = [];
    for (const provider of candidates) {
      const started = options.clock.monotonic();
      const result = await provider.discover(context);
      const elapsed = options.clock.monotonic() - started;
      if (result.ok) {
        context.logger.info('hardware discovered', {
          provider: provider.id,
          fidelity: result.value.fidelity,
          elapsedMs: elapsed,
          warnings: result.value.warnings.length,
        });
        if (options.paths) await this.persist(options.paths, result.value, options.clock);
        return result;
      }
      failures.push(`${provider.id}: ${result.error.code} ${result.error.message}`);
      context.logger.warn('hardware provider failed', { provider: provider.id, error: result.error.message });
    }

    return err(
      nexusError('E_UNAVAILABLE', 'every hardware provider failed', { failures }),
    );
  }

  /** Persist the latest report plus a timestamped copy for the audit trail. */
  private async persist(paths: NexusPaths, inventory: HardwareInventory, clock: Clock): Promise<void> {
    const stamp = new Date(clock.now()).toISOString().replace(/[:.]/g, '-');
    await writeJson(path.join(paths.discovery, 'latest.json'), inventory);
    await writeJson(path.join(paths.discovery, `inventory-${stamp}.json`), inventory);
  }
}

/** Human-readable one-line summary used by the CLI and health output. */
export function describeInventory(inventory: HardwareInventory): string {
  const gpu = selectPrimaryGpuFromInventory(inventory);
  const vram = gpu?.vramBytes;
  const parts = [
    inventory.cpu.model ?? 'unknown CPU',
    gpu?.model ?? 'unknown GPU',
    vram === null || vram === undefined ? 'unknown VRAM' : `${(vram / 1024 ** 3).toFixed(0)} GB VRAM`,
    inventory.memory.installedBytes === null
      ? 'unknown RAM'
      : `${(inventory.memory.installedBytes / 1024 ** 3).toFixed(0)} GB RAM`,
    inventory.os.name ?? inventory.os.platform,
  ];
  return `${parts.join(' | ')} (${inventory.fidelity})`;
}
