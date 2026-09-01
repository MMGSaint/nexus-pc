/**
 * Telemetry model.
 *
 * The defining constraint: "unknown" must never be representable as zero. A
 * reading either has a real measured number and status `ok`, or it has
 * `value: null` and a status that says why. Construction helpers enforce that
 * pairing so the invariant cannot drift.
 */

import type { Fidelity } from '../core/fidelity.js';

export const UNITS = [
  'percent',
  'celsius',
  'watt',
  'megahertz',
  'byte',
  'rpm',
  'millisecond',
  'count',
  'ratio',
] as const;
export type Unit = (typeof UNITS)[number];

export const METRIC_IDS = [
  'cpu.utilization',
  'cpu.temperature',
  'cpu.power',
  'cpu.clock',
  'gpu.utilization',
  'gpu.temperature',
  'gpu.hotspot',
  'gpu.power',
  'gpu.clock',
  'gpu.vram.used',
  'gpu.vram.total',
  'gpu.fan.rpm',
  'gpu.fan.percent',
  'memory.used',
  'memory.available',
  'memory.total',
  'storage.temperature',
  'storage.free',
  'system.fan.rpm',
  'nexus.self.cpu',
  'nexus.self.rss',
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

export const METRIC_UNITS: Readonly<Record<MetricId, Unit>> = Object.freeze({
  'cpu.utilization': 'percent',
  'cpu.temperature': 'celsius',
  'cpu.power': 'watt',
  'cpu.clock': 'megahertz',
  'gpu.utilization': 'percent',
  'gpu.temperature': 'celsius',
  'gpu.hotspot': 'celsius',
  'gpu.power': 'watt',
  'gpu.clock': 'megahertz',
  'gpu.vram.used': 'byte',
  'gpu.vram.total': 'byte',
  'gpu.fan.rpm': 'rpm',
  'gpu.fan.percent': 'percent',
  'memory.used': 'byte',
  'memory.available': 'byte',
  'memory.total': 'byte',
  'storage.temperature': 'celsius',
  'storage.free': 'byte',
  'system.fan.rpm': 'rpm',
  'nexus.self.cpu': 'percent',
  'nexus.self.rss': 'byte',
});

export const READING_STATUSES = [
  /** A real measurement. `value` is non-null. */
  'ok',
  /** The interface exists but produced nothing this cycle. */
  'unavailable',
  /** The last known value is older than its freshness budget. */
  'stale',
  /** A value arrived and was rejected by plausibility checks. */
  'invalid',
  /** No interface on this machine can produce this metric. */
  'unsupported',
] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export interface Reading {
  readonly metric: MetricId;
  /** Non-null if and only if `status === 'ok'`. */
  readonly value: number | null;
  readonly unit: Unit;
  readonly timestampMs: number;
  /** Identifier of the telemetry source that produced it. */
  readonly source: string;
  readonly fidelity: Fidelity;
  readonly status: ReadingStatus;
  /** 0..1. Sources that cannot justify a number report low confidence. */
  readonly confidence: number;
  readonly note?: string;
}

export interface ReadingInit {
  readonly metric: MetricId;
  readonly value: number;
  readonly timestampMs: number;
  readonly source: string;
  readonly fidelity: Fidelity;
  readonly confidence?: number;
  readonly note?: string;
}

/** Construct an `ok` reading. Callers must have a real number. */
export function reading(init: ReadingInit): Reading {
  const base = {
    metric: init.metric,
    value: init.value,
    unit: METRIC_UNITS[init.metric],
    timestampMs: init.timestampMs,
    source: init.source,
    fidelity: init.fidelity,
    status: 'ok' as const,
    confidence: init.confidence ?? 1,
  };
  return init.note === undefined ? base : { ...base, note: init.note };
}

export interface UnknownReadingInit {
  readonly metric: MetricId;
  readonly timestampMs: number;
  readonly source: string;
  readonly status: Exclude<ReadingStatus, 'ok'>;
  readonly note?: string;
  readonly fidelity?: Fidelity;
}

/** Construct a reading that carries no number. Never fabricates a zero. */
export function unknownReading(init: UnknownReadingInit): Reading {
  const base = {
    metric: init.metric,
    value: null,
    unit: METRIC_UNITS[init.metric],
    timestampMs: init.timestampMs,
    source: init.source,
    fidelity: init.fidelity ?? 'unavailable',
    status: init.status,
    confidence: 0,
  };
  return init.note === undefined ? base : { ...base, note: init.note };
}

export function isKnown(r: Reading): r is Reading & { value: number } {
  return r.status === 'ok' && r.value !== null;
}

/** A coherent set of readings taken at one moment. */
export interface TelemetrySnapshot {
  readonly timestampMs: number;
  readonly readings: readonly Reading[];
  /** Weakest fidelity across contributing readings. */
  readonly fidelity: Fidelity;
  /** Sampling mode that produced this snapshot. */
  readonly samplingMode: SamplingMode;
}

export const SAMPLING_MODES = ['low_activity', 'active_workload', 'optimization', 'suspended'] as const;
export type SamplingMode = (typeof SAMPLING_MODES)[number];

export function findReading(snapshot: TelemetrySnapshot, metric: MetricId): Reading | undefined {
  return snapshot.readings.find((r) => r.metric === metric);
}

export function knownValue(snapshot: TelemetrySnapshot, metric: MetricId): number | null {
  const r = findReading(snapshot, metric);
  return r && isKnown(r) ? r.value : null;
}

/** Per-metric aggregate over a window. `samples` counts only `ok` readings. */
export interface MetricSummary {
  readonly metric: MetricId;
  readonly unit: Unit;
  readonly samples: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly p95: number | null;
  readonly last: number | null;
  readonly fidelity: Fidelity;
  /** Fraction of attempted samples that produced a usable number, 0..1. */
  readonly coverage: number;
}

export interface TelemetrySummary {
  readonly fromMs: number;
  readonly toMs: number;
  readonly metrics: readonly MetricSummary[];
  readonly fidelity: Fidelity;
  readonly sampleCount: number;
}
