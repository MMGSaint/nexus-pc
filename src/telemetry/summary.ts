/**
 * Telemetry aggregation.
 *
 * Summaries carry `coverage` — the fraction of attempted samples that produced
 * a usable number — so a mean computed from two readings out of sixty is
 * visibly weak rather than quietly authoritative.
 */

import type { Fidelity } from '../core/fidelity.js';
import { combineFidelity } from '../core/fidelity.js';
import type {
  MetricId,
  MetricSummary,
  TelemetrySnapshot,
  TelemetrySummary,
} from '../domain/telemetry.js';
import { METRIC_UNITS, isKnown } from '../domain/telemetry.js';

export function summarize(
  snapshots: readonly TelemetrySnapshot[],
  metrics?: readonly MetricId[],
): TelemetrySummary {
  const wanted = metrics ?? collectMetrics(snapshots);
  const fromMs = snapshots.length > 0 ? (snapshots[0]?.timestampMs ?? 0) : 0;
  const toMs = snapshots.length > 0 ? (snapshots[snapshots.length - 1]?.timestampMs ?? 0) : 0;

  const summaries: MetricSummary[] = wanted.map((metric) => summarizeMetric(snapshots, metric));
  const contributing = summaries.filter((s) => s.samples > 0).map((s) => s.fidelity);

  return {
    fromMs,
    toMs,
    metrics: summaries,
    fidelity: contributing.length === 0 ? 'unavailable' : combineFidelity(...contributing),
    sampleCount: snapshots.length,
  };
}

export function summarizeMetric(
  snapshots: readonly TelemetrySnapshot[],
  metric: MetricId,
): MetricSummary {
  const values: number[] = [];
  const fidelities: Fidelity[] = [];
  let attempts = 0;
  let last: number | null = null;

  for (const snapshot of snapshots) {
    const reading = snapshot.readings.find((r) => r.metric === metric);
    if (!reading) continue;
    attempts += 1;
    if (!isKnown(reading)) continue;
    values.push(reading.value);
    fidelities.push(reading.fidelity);
    last = reading.value;
  }

  if (values.length === 0) {
    return {
      metric,
      unit: METRIC_UNITS[metric],
      samples: 0,
      min: null,
      max: null,
      mean: null,
      p95: null,
      last: null,
      fidelity: 'unavailable',
      coverage: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);

  return {
    metric,
    unit: METRIC_UNITS[metric],
    samples: values.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean: sum / values.length,
    p95: percentile(sorted, 0.95),
    last,
    fidelity: combineFidelity(...fidelities),
    coverage: attempts === 0 ? 0 : values.length / attempts,
  };
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (rank - lower);
}

function collectMetrics(snapshots: readonly TelemetrySnapshot[]): MetricId[] {
  const seen = new Set<MetricId>();
  for (const snapshot of snapshots) {
    for (const reading of snapshot.readings) seen.add(reading.metric);
  }
  return [...seen].sort();
}

/**
 * Noise floor per metric, used to decide whether a before/after difference is
 * a real effect or measurement scatter. These are conservative: NEXUS would
 * rather call a marginal win "no measurable benefit" than claim a win it
 * cannot demonstrate.
 */
export const NOISE_FLOOR: Readonly<Partial<Record<MetricId, number>>> = Object.freeze({
  'cpu.utilization': 5,
  'gpu.utilization': 5,
  'cpu.temperature': 2,
  'gpu.temperature': 2,
  'gpu.hotspot': 3,
  'cpu.power': 5,
  'gpu.power': 8,
  'cpu.clock': 100,
  'gpu.clock': 50,
  'memory.available': 512 * 1024 * 1024,
});

export function isSignificantChange(metric: MetricId, delta: number): boolean {
  const floor = NOISE_FLOOR[metric];
  if (floor === undefined) return delta !== 0;
  return Math.abs(delta) >= floor;
}
