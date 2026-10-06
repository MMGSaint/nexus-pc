/**
 * Before/after measurement.
 *
 * The comparison is deliberately conservative. A difference smaller than the
 * metric's noise floor is reported as not significant, and a change with no
 * significant improvement is reported as "no measurable benefit" rather than
 * being talked up. NEXUS would rather under-claim than produce numbers it
 * cannot stand behind.
 */

import type { MetricId, TelemetrySummary } from '../domain/telemetry.js';
import { METRIC_UNITS } from '../domain/telemetry.js';
import type { MeasurementDelta } from '../domain/optimization.js';
import { isSignificantChange } from '../telemetry/summary.js';

/** Metrics compared after a change, and which direction counts as better. */
export const COMPARED_METRICS: readonly { metric: MetricId; betterWhen: 'higher' | 'lower' }[] = Object.freeze([
  { metric: 'cpu.utilization', betterWhen: 'lower' },
  { metric: 'gpu.utilization', betterWhen: 'higher' },
  { metric: 'cpu.clock', betterWhen: 'higher' },
  { metric: 'cpu.temperature', betterWhen: 'lower' },
  { metric: 'gpu.temperature', betterWhen: 'lower' },
  { metric: 'gpu.hotspot', betterWhen: 'lower' },
  { metric: 'cpu.power', betterWhen: 'lower' },
  { metric: 'memory.available', betterWhen: 'higher' },
  // PresentMon-derived frame truth: these are primary gaming evidence, not cosmetic stats.
  { metric: 'frame.time', betterWhen: 'lower' },
  { metric: 'frame.fps', betterWhen: 'higher' },
  { metric: 'frame.1pct_low', betterWhen: 'higher' },
  { metric: 'frame.0_1pct_low', betterWhen: 'higher' },
  { metric: 'frame.time.p95', betterWhen: 'lower' },
  { metric: 'frame.time.p99', betterWhen: 'lower' },
  { metric: 'frame.time.stddev', betterWhen: 'lower' },
]);

export function compare(before: TelemetrySummary, after: TelemetrySummary): MeasurementDelta[] {
  const out: MeasurementDelta[] = [];
  for (const { metric } of COMPARED_METRICS) {
    const b = before.metrics.find((m) => m.metric === metric)?.mean ?? null;
    const a = after.metrics.find((m) => m.metric === metric)?.mean ?? null;
    const delta = b !== null && a !== null ? a - b : null;
    out.push({
      metric,
      before: b,
      after: a,
      delta,
      unit: METRIC_UNITS[metric],
      significant: delta !== null && isSignificantChange(metric, delta),
    });
  }
  return out;
}

export interface RegressionFinding {
  /** Metric identifier as carried on the delta (a plain string on the wire). */
  readonly metric: string;
  readonly message: string;
}

/**
 * Thermal regressions are treated as the hard stop. A change that gains a
 * little throughput while raising package temperature by ten degrees is not a
 * win, and NEXUS is not in a position to judge the user's tolerance for it.
 */
export const THERMAL_REGRESSION_C = 8;

export function findRegressions(deltas: readonly MeasurementDelta[]): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  for (const delta of deltas) {
    if (delta.delta === null || !delta.significant) continue;
    const spec = COMPARED_METRICS.find((m) => m.metric === delta.metric);
    if (!spec) continue;

    const worse = spec.betterWhen === 'lower' ? delta.delta > 0 : delta.delta < 0;
    if (!worse) continue;

    const isThermal = delta.metric === 'cpu.temperature' || delta.metric === 'gpu.temperature' || delta.metric === 'gpu.hotspot';
    if (isThermal && Math.abs(delta.delta) >= THERMAL_REGRESSION_C) {
      findings.push({
        metric: delta.metric,
        message: `${delta.metric} rose by ${delta.delta.toFixed(1)}°C, at or above the ${THERMAL_REGRESSION_C}°C regression threshold`,
      });
      continue;
    }
    if (!isThermal) {
      findings.push({
        metric: delta.metric,
        message: `${delta.metric} moved ${delta.delta.toFixed(1)} ${delta.unit} in the unwanted direction`,
      });
    }
  }
  return findings;
}

export function hasMeasurableBenefit(deltas: readonly MeasurementDelta[]): boolean {
  return deltas.some((delta) => {
    if (delta.delta === null || !delta.significant) return false;
    const spec = COMPARED_METRICS.find((m) => m.metric === delta.metric);
    if (!spec) return false;
    return spec.betterWhen === 'lower' ? delta.delta < 0 : delta.delta > 0;
  });
}

/** Did the measurement window actually observe anything? */
export function measurementIsUsable(before: TelemetrySummary, after: TelemetrySummary): boolean {
  const coverage = (s: TelemetrySummary): number =>
    s.metrics.length === 0 ? 0 : s.metrics.reduce((acc, m) => acc + m.coverage, 0) / s.metrics.length;
  return before.sampleCount > 0 && after.sampleCount > 0 && coverage(before) > 0 && coverage(after) > 0;
}
