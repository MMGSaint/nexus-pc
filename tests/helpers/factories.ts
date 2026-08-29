/**
 * Deterministic test fixtures. Nothing here reads the real machine.
 */

import type { CapabilityId, CapabilityRecord } from '../../src/domain/capability.js';
import type { ControlId } from '../../src/domain/control.js';
import type { OptimizationProposal, ProposedChange } from '../../src/domain/optimization.js';
import type { Reading, TelemetrySnapshot } from '../../src/domain/telemetry.js';
import { reading } from '../../src/domain/telemetry.js';
import type { Fidelity } from '../../src/core/fidelity.js';
import type { SafetyContext } from '../../src/safety/kernel.js';

export const T0 = 1_700_000_000_000;

export function capability(
  id: CapabilityId,
  overrides: Partial<CapabilityRecord> = {},
): CapabilityRecord {
  return {
    id,
    name: id,
    description: `test capability ${id}`,
    access: 'read-write',
    safetyClass: 'reversible',
    hardwareDependent: true,
    backend: 'test',
    requiresElevation: false,
    reversibility: 'reversible',
    state: 'available',
    fidelity: 'live',
    detail: 'probed in test',
    probedAtMs: T0,
    ...overrides,
  };
}

export function capabilityMap(
  ids: readonly CapabilityId[],
  overrides: Partial<CapabilityRecord> = {},
): Map<CapabilityId, CapabilityRecord> {
  return new Map(ids.map((id) => [id, capability(id, overrides)]));
}

export const ALL_POWER_CAPS: readonly CapabilityId[] = [
  'power.scheme.read',
  'power.scheme.write',
  'power.setting.read',
  'power.setting.write',
  'process.enumerate',
  'process.priority.write',
];

export function telemetrySnapshot(
  overrides: {
    readonly cpuTempC?: number | null;
    readonly gpuTempC?: number | null;
    readonly hotspotC?: number | null;
    readonly fidelity?: Fidelity;
    readonly timestampMs?: number;
  } = {},
): TelemetrySnapshot {
  const ts = overrides.timestampMs ?? T0;
  const fidelity = overrides.fidelity ?? 'live';
  const readings: Reading[] = [];
  const add = (metric: 'cpu.temperature' | 'gpu.temperature' | 'gpu.hotspot', value: number | null | undefined): void => {
    if (value === null || value === undefined) return;
    readings.push(reading({ metric, value, timestampMs: ts, source: 'test', fidelity }));
  };
  add('cpu.temperature', overrides.cpuTempC === undefined ? 55 : overrides.cpuTempC);
  add('gpu.temperature', overrides.gpuTempC === undefined ? 50 : overrides.gpuTempC);
  add('gpu.hotspot', overrides.hotspotC === undefined ? 65 : overrides.hotspotC);
  readings.push(reading({ metric: 'cpu.utilization', value: 20, timestampMs: ts, source: 'test', fidelity }));
  return { timestampMs: ts, readings, fidelity, samplingMode: 'active_workload' };
}

export function change(control: ControlId, targetValue: ProposedChange['targetValue']): ProposedChange {
  return {
    control,
    targetValue,
    rationale: 'test rationale',
    expectedEffect: 'test expectation',
  };
}

export function proposal(overrides: Partial<OptimizationProposal> = {}): OptimizationProposal {
  return {
    id: 'prop_test',
    createdAtMs: T0,
    origin: 'internal',
    requestedBy: 'test',
    workload: 'gaming',
    changes: [change('power.processor.min_state', 20)],
    ...overrides,
  };
}

export function safetyContext(overrides: Partial<SafetyContext> = {}): SafetyContext {
  return {
    nowMs: T0,
    runState: 'ready',
    capabilities: capabilityMap(ALL_POWER_CAPS),
    telemetry: telemetrySnapshot(),
    baselineAvailable: true,
    recentApplications: [],
    actuatorFidelity: () => 'live',
    ...overrides,
  };
}
