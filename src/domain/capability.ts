/**
 * Capabilities describe what NEXUS can actually do *on this machine*.
 *
 * The central rule: writing an adapter does not create a capability. A
 * capability is `available` only after its probe succeeded here, now. Anything
 * else is `unverified`, `unavailable`, `unsupported`, or `mocked`.
 */

import type { Fidelity } from '../core/fidelity.js';

export const CAPABILITY_STATES = [
  /** Probed on this machine and working. */
  'available',
  /** Probed and not working (interface missing, permission denied, absent hardware). */
  'unavailable',
  /** Not probed yet, or the probe was inconclusive. Never treated as available. */
  'unverified',
  /** Cannot exist on this platform/hardware at all. */
  'unsupported',
  /** Backed by fixtures or a simulator. Never treated as live. */
  'mocked',
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/**
 * How dangerous the capability is when exercised.
 *
 * `prohibited` capabilities exist in the registry so that a request naming one
 * can be refused with a precise reason instead of an unhelpful "unknown".
 */
export const SAFETY_CLASSES = [
  /** Read-only observation. */
  'observation',
  /** Write, trivially reversible, no thermal or power consequence. */
  'benign',
  /** Write, fully reversible system configuration. */
  'reversible',
  /** Affects the power or thermal envelope. Requires live telemetry to use. */
  'sensitive',
  /** Requires explicit human confirmation every time. Never automatic. */
  'restricted',
  /** NEXUS will never perform this. Present so it can be refused by name. */
  'prohibited',
] as const;
export type SafetyClass = (typeof SAFETY_CLASSES)[number];

export const ACCESS_MODES = ['read', 'write', 'read-write'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export type CapabilityId = string;

/** The canonical capability identifiers NEXUS knows about. */
export const CAPABILITY_IDS = [
  'system.inventory',
  'cpu.identity',
  'cpu.telemetry.utilization',
  'cpu.telemetry.temperature',
  'cpu.telemetry.clock',
  'cpu.telemetry.power',
  'gpu.identity',
  'gpu.telemetry.utilization',
  'gpu.telemetry.temperature',
  'gpu.telemetry.hotspot',
  'gpu.telemetry.vram',
  'gpu.telemetry.power',
  'gpu.telemetry.clock',
  'fan.telemetry',
  'fan.control',
  'memory.telemetry',
  'storage.telemetry',
  'storage.telemetry.temperature',
  'process.enumerate',
  'process.foreground',
  'process.cpuset.read',
  'process.cpuset.write',
  'cpu.topology',
  'process.priority.write',
  'workload.detect',
  'power.scheme.read',
  'power.scheme.write',
  'power.setting.read',
  'power.setting.write',
  'gpu.tuning.write',
  'cpu.tuning.write',
  'profile.apply',
  'checkpoint.write',
  'vesper.ipc',
] as const;
export type KnownCapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly name: string;
  readonly description: string;
  readonly access: AccessMode;
  readonly safetyClass: SafetyClass;
  /** True when the capability cannot be satisfied without physical hardware. */
  readonly hardwareDependent: boolean;
  /** Human-readable identifier for the interface behind it, e.g. "windows.cim". */
  readonly backend: string;
  readonly requiresElevation: boolean;
  /** For write capabilities: can the effect be undone by NEXUS? */
  readonly reversibility: Reversibility;
}

export const REVERSIBILITIES = [
  'not-applicable',
  'reversible',
  'reversible-after-reboot',
  'irreversible',
  'unknown',
] as const;
export type Reversibility = (typeof REVERSIBILITIES)[number];

/** A descriptor plus the outcome of probing it on this machine. */
export interface CapabilityRecord extends CapabilityDescriptor {
  readonly state: CapabilityState;
  readonly fidelity: Fidelity;
  /** Why the capability is in this state — always populated for non-available. */
  readonly detail: string;
  /** Wall-clock ms of the probe that produced this state, or null if never probed. */
  readonly probedAtMs: number | null;
  /** Version of the backing interface when it can be determined. */
  readonly backendVersion?: string;
}

export function isUsable(record: CapabilityRecord): boolean {
  return record.state === 'available';
}

/**
 * Whether the capability may be used as evidence, or to justify, a real
 * hardware change. Mocked capabilities deliberately fail this check.
 */
export function isLiveCapability(record: CapabilityRecord): boolean {
  return record.state === 'available' && record.fidelity === 'live';
}
