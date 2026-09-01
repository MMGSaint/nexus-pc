/**
 * Controls are the machine settings NEXUS is allowed to read and, sometimes,
 * write. The descriptor is the single source of truth for what a control is,
 * what values it accepts, and what it costs to touch it.
 *
 * A control that is not in the registry cannot be proposed, validated or
 * applied. There is no dynamic control creation path — deliberately, so that
 * neither a config file nor a model response can invent one.
 */

import type { Unit } from './telemetry.js';
import type { CapabilityId, Reversibility, SafetyClass } from './capability.js';

export type ControlId = string;

export type ControlValue = string | number | boolean;

export type ValueSpec =
  | { readonly kind: 'enum'; readonly values: readonly EnumOption[] }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number; readonly unit: Unit | 'none'; readonly step?: number }
  | { readonly kind: 'boolean' }
  /**
   * A value NEXUS never synthesises and only ever restores verbatim — e.g. a
   * power scheme GUID captured in a checkpoint.
   */
  | { readonly kind: 'opaque'; readonly note: string };

export interface EnumOption {
  readonly value: string;
  readonly label: string;
}

/**
 * How well supported the *claim that this control helps* is. NEXUS refuses to
 * auto-propose anything `contested`: plenty of widely repeated PC "optimizer"
 * tweaks have no measured benefit, and shipping them as automatic behaviour
 * would be exactly the cargo-cult product this system is meant not to be.
 */
export const EVIDENCE_LEVELS = ['measured', 'documented', 'plausible', 'contested'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const APPLY_TIMINGS = ['immediate', 'requires-reboot', 'next-session'] as const;
export type ApplyTiming = (typeof APPLY_TIMINGS)[number];

export interface ControlDescriptor {
  readonly id: ControlId;
  readonly name: string;
  readonly description: string;
  readonly domain: 'power' | 'cpu' | 'gpu' | 'os' | 'process' | 'memory' | 'storage';
  readonly valueSpec: ValueSpec;
  readonly access: 'read' | 'read-write';
  readonly safetyClass: SafetyClass;
  readonly reversibility: Reversibility;
  readonly applyTiming: ApplyTiming;
  readonly requiresElevation: boolean;
  /** Capabilities that must be `available` before this control can be used. */
  readonly requiresCapabilities: readonly CapabilityId[];
  readonly evidenceLevel: EvidenceLevel;
  /**
   * When false, NEXUS will never include this control in a proposal it
   * generated itself. An explicit human request can still reach it, subject to
   * the rest of the safety kernel.
   */
  readonly autoProposable: boolean;
  readonly notes?: string;
}

export interface ControlState {
  readonly control: ControlId;
  readonly value: ControlValue | null;
  readonly readable: boolean;
  readonly capturedAtMs: number;
  readonly source: string;
  readonly note?: string;
}

/** Does `value` satisfy `spec`? Purely structural; no policy applied here. */
export function valueMatchesSpec(spec: ValueSpec, value: ControlValue): boolean {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.some((o) => o.value === value);
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return false;
      if (value < spec.min || value > spec.max) return false;
      if (spec.step !== undefined && spec.step > 0) {
        return Number.isInteger((value - spec.min) / spec.step);
      }
      return true;
    case 'boolean':
      return typeof value === 'boolean';
    case 'opaque':
      return typeof value === 'string' && value.length > 0 && value.length <= 256;
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}

export function describeValueSpec(spec: ValueSpec): string {
  switch (spec.kind) {
    case 'enum':
      return `one of ${spec.values.map((v) => v.value).join(', ')}`;
    case 'integer':
      return `integer ${spec.min}..${spec.max}${spec.unit === 'none' ? '' : ` ${spec.unit}`}`;
    case 'boolean':
      return 'true or false';
    case 'opaque':
      return `opaque value (${spec.note})`;
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}
