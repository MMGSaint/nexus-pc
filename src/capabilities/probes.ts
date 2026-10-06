/**
 * Capability probe construction.
 *
 * Probes are built from things that have already happened: discovery ran or it
 * did not, the first telemetry sample produced a number for a metric or it did
 * not, an adapter answered its own probe or it did not. Nothing here asserts a
 * capability from the mere existence of code.
 */

import type { Fidelity } from '../core/fidelity.js';
import type { CapabilityDescriptor, CapabilityId } from '../domain/capability.js';
import type { HardwareInventory } from '../domain/hardware.js';
import { selectPrimaryGpuFromInventory } from '../hardware/primary-gpu.js';
import type { MetricId, TelemetrySnapshot } from '../domain/telemetry.js';
import { isKnown } from '../domain/telemetry.js';
import type { ActuatorContext } from '../optimizer/actuator.js';
import type { ActuatorRegistry } from '../optimizer/actuator.js';
import { getControl } from '../safety/controls.js';
import type { ProcessEnumerator } from '../process/enumerate.js';
import { probeProcessEnumeration } from '../process/enumerate.js';
import type { CapabilityProbe, ProbeOutcome } from './registry.js';

function descriptor(
  id: CapabilityId,
  name: string,
  description: string,
  overrides: Partial<CapabilityDescriptor> = {},
): CapabilityDescriptor {
  return {
    id,
    name,
    description,
    access: 'read',
    safetyClass: 'observation',
    hardwareDependent: true,
    backend: 'unknown',
    requiresElevation: false,
    reversibility: 'not-applicable',
    ...overrides,
  };
}

export interface ProbeSources {
  readonly inventory: HardwareInventory | null;
  /** First telemetry snapshot, used to decide which metrics really work. */
  readonly snapshot: TelemetrySnapshot | null;
  readonly registry: ActuatorRegistry;
  readonly actuatorContext: ActuatorContext;
  readonly platform: NodeJS.Platform;
  readonly vesperListening: boolean;
  /** Live process enumerator; probed rather than assumed from code existence. */
  readonly processEnumerator: ProcessEnumerator;
}

/** Telemetry capabilities and the metric each one depends on. */
const TELEMETRY_CAPABILITIES: readonly {
  id: CapabilityId;
  metric: MetricId;
  name: string;
  description: string;
}[] = [
  {
    id: 'cpu.telemetry.utilization',
    metric: 'cpu.utilization',
    name: 'CPU utilisation',
    description: 'Live processor utilisation.',
  },
  {
    id: 'cpu.telemetry.clock',
    metric: 'cpu.clock',
    name: 'CPU clock',
    description: 'Live processor frequency.',
  },
  {
    id: 'cpu.telemetry.temperature',
    metric: 'cpu.temperature',
    name: 'CPU temperature',
    description:
      'Processor die temperature. Windows exposes no in-box source for this; it requires the optional sensor bridge.',
  },
  {
    id: 'cpu.telemetry.power',
    metric: 'cpu.power',
    name: 'CPU package power',
    description: 'Processor package power draw. Requires the optional sensor bridge on Windows.',
  },
  {
    id: 'gpu.telemetry.utilization',
    metric: 'gpu.utilization',
    name: 'GPU utilisation',
    description: 'Graphics engine utilisation.',
  },
  {
    id: 'gpu.telemetry.vram',
    metric: 'gpu.vram.used',
    name: 'GPU memory in use',
    description: 'Dedicated video memory currently in use.',
  },
  {
    id: 'gpu.telemetry.temperature',
    metric: 'gpu.temperature',
    name: 'GPU temperature',
    description: 'Graphics edge temperature. Requires the optional sensor bridge on Windows.',
  },
  {
    id: 'gpu.telemetry.hotspot',
    metric: 'gpu.hotspot',
    name: 'GPU hotspot temperature',
    description: 'Graphics junction temperature. Requires the optional sensor bridge on Windows.',
  },
  {
    id: 'gpu.telemetry.power',
    metric: 'gpu.power',
    name: 'GPU power',
    description: 'Graphics board power draw. Requires the optional sensor bridge on Windows.',
  },
  {
    id: 'gpu.telemetry.clock',
    metric: 'gpu.clock',
    name: 'GPU clock',
    description: 'Graphics core frequency. Requires the optional sensor bridge on Windows.',
  },
  {
    id: 'fan.telemetry',
    metric: 'gpu.fan.rpm',
    name: 'Fan speed',
    description: 'Fan speed in RPM. Requires the optional sensor bridge on Windows.',
  },
  {
    id: 'memory.telemetry',
    metric: 'memory.available',
    name: 'System memory',
    description: 'System memory in use and available.',
  },
];

/** Control capabilities, resolved by asking the adapter to probe itself. */
const CONTROL_CAPABILITIES: readonly { id: CapabilityId; controls: readonly string[]; write: boolean; name: string }[] = [
  { id: 'power.scheme.read', controls: ['power.scheme.active'], write: false, name: 'Read the active power scheme' },
  { id: 'power.scheme.write', controls: ['power.scheme.active'], write: true, name: 'Change the active power scheme' },
  {
    id: 'power.setting.read',
    controls: ['power.processor.epp', 'power.processor.min_state', 'power.processor.max_state'],
    write: false,
    name: 'Read power scheme settings',
  },
  {
    id: 'power.setting.write',
    controls: ['power.processor.min_state', 'power.processor.max_state'],
    write: true,
    name: 'Change power scheme settings',
  },
];

export function buildCapabilityProbes(sources: () => ProbeSources): CapabilityProbe[] {
  const probes: CapabilityProbe[] = [];

  probes.push({
    descriptor: descriptor('system.inventory', 'Hardware inventory', 'Discovery of the machine NEXUS is running on.', {
      backend: 'hardware.discovery',
    }),
    trust: 'live',
    probe: async (): Promise<ProbeOutcome> => {
      const { inventory } = sources();
      if (!inventory) return { state: 'unavailable', detail: 'hardware discovery has not produced an inventory' };
      return {
        state: inventory.fidelity === 'live' ? 'available' : 'mocked',
        fidelity: inventory.fidelity,
        detail: `inventory captured by ${inventory.provider}`,
      };
    },
  });

  for (const [id, name, field] of [
    ['cpu.identity', 'CPU identity', 'cpu'],
    ['gpu.identity', 'GPU identity', 'gpu'],
  ] as const) {
    probes.push({
      descriptor: descriptor(id, name, `Identification of the ${field === 'cpu' ? 'processor' : 'graphics adapter'}.`, {
        backend: 'hardware.discovery',
      }),
      trust: 'live',
      probe: async (): Promise<ProbeOutcome> => {
        const { inventory } = sources();
        if (!inventory) return { state: 'unavailable', detail: 'no inventory' };
        const value = field === 'cpu' ? inventory.cpu.model : selectPrimaryGpuFromInventory(inventory)?.model;
        if (!value) return { state: 'unavailable', detail: 'discovery could not identify this component' };
        return {
          state: inventory.fidelity === 'live' ? 'available' : 'mocked',
          fidelity: inventory.fidelity,
          detail: value,
        };
      },
    });
  }

  for (const entry of TELEMETRY_CAPABILITIES) {
    probes.push({
      descriptor: descriptor(entry.id, entry.name, entry.description, { backend: 'telemetry.pipeline' }),
      trust: 'live',
      probe: async (): Promise<ProbeOutcome> => {
        const { snapshot } = sources();
        if (!snapshot) return { state: 'unverified', detail: 'no telemetry sample has been taken yet' };
        const reading = snapshot.readings.find((r) => r.metric === entry.metric);
        if (!reading) {
          return { state: 'unavailable', detail: 'no telemetry source claims this metric on this machine' };
        }
        if (!isKnown(reading)) {
          return {
            state: reading.status === 'unsupported' ? 'unsupported' : 'unavailable',
            detail: reading.note ?? `the source reported "${reading.status}"`,
          };
        }
        return {
          state: reading.fidelity === 'live' ? 'available' : 'mocked',
          fidelity: reading.fidelity,
          detail: `${reading.source} produced a reading`,
        };
      },
    });
  }

  for (const entry of CONTROL_CAPABILITIES) {
    const anyControl = entry.controls[0] ?? '';
    const control = getControl(anyControl);
    probes.push({
      descriptor: descriptor(
        entry.id,
        entry.name,
        control?.description ?? entry.name,
        {
          access: entry.write ? 'write' : 'read',
          safetyClass: entry.write ? 'reversible' : 'observation',
          backend: 'windows.powercfg',
          requiresElevation: entry.write && (control?.requiresElevation ?? false),
          reversibility: entry.write ? 'reversible' : 'not-applicable',
        },
      ),
      trust: 'live',
      probe: async (): Promise<ProbeOutcome> => {
        const { registry, actuatorContext, platform } = sources();
        if (platform !== 'win32') {
          return { state: 'unsupported', detail: 'Windows power scheme controls exist only on Windows' };
        }
        const adapters = entry.controls.map((c) => registry.get(c)).filter((a) => a !== undefined);
        if (adapters.length === 0) {
          return { state: 'unavailable', detail: 'no adapter is registered for these controls' };
        }
        const failures: string[] = [];
        let trust: Fidelity = 'live';
        for (const adapter of adapters) {
          const probed = await adapter.probe(actuatorContext);
          if (!probed.ok) failures.push(`${adapter.control}: ${probed.error.message}`);
          if (adapter.trust !== 'live') trust = adapter.trust;
        }
        // Every adapter behind the capability must probe. `available` is what
        // the safety kernel treats as proof a change is possible, so a
        // capability that only half works must not claim it.
        if (failures.length > 0) {
          return {
            state: 'unavailable',
            detail:
              failures.length === adapters.length
                ? failures.join('; ')
                : `only some of the controls behind this capability are usable: ${failures.join('; ')}`,
          };
        }
        return {
          state: trust === 'live' ? 'available' : 'mocked',
          fidelity: trust,
          detail: 'probed successfully',
        };
      },
    });
  }

  probes.push({
    descriptor: descriptor(
      'process.enumerate',
      'Process enumeration',
      'List running processes (name, pid, optional working set) for workload corroboration.',
      {
        backend: 'process.enumerate',
        hardwareDependent: true,
      },
    ),
    trust: 'live',
    probe: async (): Promise<ProbeOutcome> => {
      const { processEnumerator } = sources();
      return probeProcessEnumeration(processEnumerator);
    },
  });

  /*
   * Declared but not implemented in this version. They are registered so a
   * request that depends on them is refused with a precise reason rather than
   * "unknown capability", and so `nexus doctor` lists them as known gaps.
   */
  for (const [id, name, reason] of [
    [
      'process.priority.write',
      'Process priority control',
      'process priority control is not implemented in this version',
    ],
    [
      'fan.control',
      'Fan control',
      'fan control is prohibited by the NEXUS safety policy and is not implemented',
    ],
    [
      'gpu.tuning.write',
      'GPU tuning',
      'silicon-level GPU tuning is prohibited by the NEXUS safety policy and is not implemented',
    ],
    [
      'cpu.tuning.write',
      'CPU tuning',
      'silicon-level CPU tuning is prohibited by the NEXUS safety policy and is not implemented',
    ],
  ] as const) {
    probes.push({
      descriptor: descriptor(id, name, reason, { backend: 'none' }),
      trust: 'live',
      probe: async (): Promise<ProbeOutcome> => ({ state: 'unavailable', detail: reason }),
    });
  }

  probes.push({
    descriptor: descriptor('vesper.ipc', 'Vesper interface', 'Local-only IPC endpoint for the Vesper orchestrator.', {
      backend: 'runtime.vesper',
      hardwareDependent: false,
    }),
    trust: 'live',
    probe: async (): Promise<ProbeOutcome> => {
      const { vesperListening } = sources();
      return vesperListening
        ? { state: 'available', detail: 'the local IPC endpoint is listening' }
        : { state: 'unavailable', detail: 'the Vesper interface is not enabled' };
    },
  });

  return probes;
}
