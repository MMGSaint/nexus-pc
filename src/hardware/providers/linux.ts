/**
 * Linux hardware discovery.
 *
 * NEXUS targets Windows. This provider exists so the runtime, the tests and
 * the CLI can be developed and exercised on a Linux host against *real* system
 * data rather than only fixtures — which keeps the abstraction honest. It
 * reads sysfs and procfs directly, with no subprocess.
 *
 * It is `live` on Linux because the readings genuinely come from this machine.
 * It is not a Windows substitute: capabilities that do not exist here are
 * reported unavailable, exactly as they would be on a Windows box missing a
 * sensor interface.
 */

import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem, release, arch } from 'node:os';

import type { NexusError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
import { ok } from '../../core/result.js';
import type { HardwareInventory, StorageDeviceInventory } from '../../domain/hardware.js';
import { EMPTY_CPU, EMPTY_MEMORY, EMPTY_POWER } from '../../domain/hardware.js';
import type { DiscoveryContext, HardwareProvider } from '../provider.js';
import { hashMachineIdentifier } from '../provider.js';

async function readOptional(file: string): Promise<string | null> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

export class LinuxHardwareProvider implements HardwareProvider {
  readonly id = 'linux.procfs';
  readonly trust = 'live' as const;

  supports(platform: NodeJS.Platform): boolean {
    return platform === 'linux';
  }

  async discover(context: DiscoveryContext): Promise<Result<HardwareInventory, NexusError>> {
    const warnings: string[] = [
      'Running on Linux. NEXUS targets Windows; Windows-only capabilities are reported unavailable here rather than emulated.',
    ];

    const cpuinfo = (await readOptional('/proc/cpuinfo')) ?? '';
    const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? null;
    const vendor = /^vendor_id\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? null;
    const flags = /^flags\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim().split(/\s+/) ?? [];
    const physicalIds = new Set<string>();
    const coreIds = new Set<string>();
    for (const block of cpuinfo.split(/\n\n+/)) {
      const phys = /^physical id\s*:\s*(\d+)$/m.exec(block)?.[1];
      const core = /^core id\s*:\s*(\d+)$/m.exec(block)?.[1];
      if (phys !== undefined && core !== undefined) {
        physicalIds.add(phys);
        coreIds.add(`${phys}:${core}`);
      }
    }

    const logical = cpus().length;
    const machineId = (await readOptional('/etc/machine-id')) ?? (await readOptional('/var/lib/dbus/machine-id'));

    const storage: StorageDeviceInventory[] = [];
    const memTotalKb = /^MemTotal:\s*(\d+) kB$/m.exec((await readOptional('/proc/meminfo')) ?? '')?.[1];

    return ok({
      capturedAtMs: context.clock.now(),
      fidelity: 'live',
      provider: this.id,
      machineIdHash: hashMachineIdentifier(machineId),
      cpu: {
        ...EMPTY_CPU,
        model,
        vendor,
        physicalCores: coreIds.size > 0 ? coreIds.size : null,
        logicalProcessors: logical > 0 ? logical : null,
        socket: physicalIds.size > 0 ? `${physicalIds.size} socket(s)` : null,
        architecture: arch(),
        features: flags.filter((f) => ['avx2', 'avx512f', 'ht', 'sse4_2'].includes(f)),
      },
      gpus: [],
      memory: {
        ...EMPTY_MEMORY,
        totalBytes: totalmem() > 0 ? totalmem() : null,
        installedBytes: memTotalKb ? Number(memTotalKb) * 1024 : null,
        availableBytes: freemem(),
        availableSource: 'os.freemem',
      },
      os: {
        platform: 'linux',
        name: (await readOptional('/etc/os-release'))?.match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1] ?? 'Linux',
        version: release(),
        build: null,
        architecture: arch(),
        kernel: release(),
      },
      storage,
      power: EMPTY_POWER,
      warnings,
    });
  }
}
