/**
 * Plausibility validation for telemetry.
 *
 * A sensor that returns nonsense is worse than a sensor that returns nothing:
 * nonsense flows into thermal preconditions and workload classification and
 * makes NEXUS confidently wrong. Every reading is therefore range-checked
 * against physically plausible bounds before it enters the pipeline, and a
 * rejected reading becomes `invalid` with `value: null` — never a zero.
 *
 * The bounds are deliberately generous. They are here to catch broken
 * plumbing, not to second-guess a real machine.
 */

import type { MetricId, Reading } from '../domain/telemetry.js';
import { unknownReading } from '../domain/telemetry.js';

export interface MetricBounds {
  readonly min: number;
  readonly max: number;
  /** How long a reading of this metric stays usable. */
  readonly maxAgeMs: number;
}

const GIB = 1024 ** 3;

export const METRIC_BOUNDS: Readonly<Record<MetricId, MetricBounds>> = Object.freeze({
  /*
   * CPU utilisation can legitimately exceed 100%. Windows' "% Processor
   * Utility" counter normalises by frequency, so a boosting CPU doing more
   * work than its nominal capacity reads above 100 — clamping it would destroy
   * exactly the signal the counter exists to provide. 200 is the sanity bound.
   */
  'cpu.utilization': { min: 0, max: 200, maxAgeMs: 15_000 },
  'cpu.temperature': { min: 5, max: 115, maxAgeMs: 15_000 },
  'cpu.power': { min: 0, max: 500, maxAgeMs: 15_000 },
  /*
   * The frequency counter derives from APERF/MPERF, which has been observed to
   * return absurd values on Ryzen after a suspend/resume cycle. Bounding it
   * turns that corruption into an explicit `invalid` rather than a fake clock.
   */
  'cpu.clock': { min: 200, max: 7_500, maxAgeMs: 15_000 },
  'gpu.utilization': { min: 0, max: 100, maxAgeMs: 15_000 },
  'gpu.temperature': { min: 5, max: 120, maxAgeMs: 15_000 },
  'gpu.hotspot': { min: 5, max: 130, maxAgeMs: 15_000 },
  'gpu.power': { min: 0, max: 1_000, maxAgeMs: 15_000 },
  'gpu.clock': { min: 50, max: 4_500, maxAgeMs: 15_000 },
  'gpu.vram.used': { min: 0, max: 256 * GIB, maxAgeMs: 15_000 },
  'gpu.vram.total': { min: 0, max: 256 * GIB, maxAgeMs: 3_600_000 },
  'gpu.fan.rpm': { min: 0, max: 12_000, maxAgeMs: 15_000 },
  'gpu.fan.percent': { min: 0, max: 100, maxAgeMs: 15_000 },
  'memory.used': { min: 0, max: 4096 * GIB, maxAgeMs: 15_000 },
  'memory.available': { min: 0, max: 4096 * GIB, maxAgeMs: 15_000 },
  'memory.total': { min: 0, max: 4096 * GIB, maxAgeMs: 3_600_000 },
  'storage.temperature': { min: 0, max: 100, maxAgeMs: 60_000 },
  'storage.free': { min: 0, max: 1024 * 1024 * GIB, maxAgeMs: 300_000 },
  'system.fan.rpm': { min: 0, max: 12_000, maxAgeMs: 15_000 },
  'frame.time': { min: 0.001, max: 10_000, maxAgeMs: 30_000 },
  'frame.fps': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.1pct_low': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.0_1pct_low': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.displayed_fps': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.presented_fps': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.application_fps': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.generated_fraction': { min: 0, max: 1, maxAgeMs: 30_000 },
  'frame.afmf_generated': { min: 0, max: 1_000_000_000, maxAgeMs: 30_000 },
  'frame.display_latency.p95': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.time.p95': { min: 0.001, max: 10_000, maxAgeMs: 30_000 },
  'frame.time.p99': { min: 0.001, max: 10_000, maxAgeMs: 30_000 },
  'frame.time.stddev': { min: 0, max: 10_000, maxAgeMs: 30_000 },
  'frame.dropped': { min: 0, max: 1_000_000_000, maxAgeMs: 30_000 },
  'nexus.self.cpu': { min: 0, max: 3_200, maxAgeMs: 60_000 },
  'nexus.self.rss': { min: 0, max: 16 * GIB, maxAgeMs: 60_000 },
});

export interface ValidationResult {
  readonly reading: Reading;
  readonly rejected: boolean;
  readonly reason?: string;
}

/**
 * Validate a reading. Already-unknown readings pass through untouched: there
 * is nothing to check, and rewriting them would lose the original status.
 */
export function validateReading(r: Reading, nowMs: number): ValidationResult {
  if (r.status !== 'ok' || r.value === null) return { reading: r, rejected: false };

  const bounds = METRIC_BOUNDS[r.metric];
  const reject = (reason: string): ValidationResult => ({
    rejected: true,
    reason,
    reading: unknownReading({
      metric: r.metric,
      timestampMs: r.timestampMs,
      source: r.source,
      status: 'invalid',
      note: reason,
      fidelity: r.fidelity,
    }),
  });

  if (!Number.isFinite(r.value)) return reject('value is not a finite number');
  if (r.value < bounds.min || r.value > bounds.max) {
    return reject(`value ${r.value} is outside the plausible range ${bounds.min}..${bounds.max}`);
  }
  if (r.timestampMs > nowMs + 5_000) {
    return reject('reading is timestamped in the future');
  }

  const age = nowMs - r.timestampMs;
  if (age > bounds.maxAgeMs) {
    return {
      rejected: true,
      reason: `reading is ${Math.round(age / 1000)}s old`,
      reading: unknownReading({
        metric: r.metric,
        timestampMs: r.timestampMs,
        source: r.source,
        status: 'stale',
        note: `older than the ${Math.round(bounds.maxAgeMs / 1000)}s freshness budget`,
        fidelity: r.fidelity,
      }),
    };
  }

  return { reading: r, rejected: false };
}

/**
 * Cross-check readings that must be consistent with each other. Used VRAM
 * above total VRAM, or used memory above total memory, means one of the two
 * sources is wrong; both are demoted rather than picking a winner.
 */
export function crossValidate(readings: readonly Reading[]): Reading[] {
  const byMetric = new Map(readings.map((r) => [r.metric, r]));
  const out = [...readings];

  const pairs: readonly [MetricId, MetricId][] = [
    ['gpu.vram.used', 'gpu.vram.total'],
    ['memory.used', 'memory.total'],
    ['memory.available', 'memory.total'],
  ];

  for (const [partId, wholeId] of pairs) {
    const part = byMetric.get(partId);
    const whole = byMetric.get(wholeId);
    if (!part || !whole) continue;
    if (part.status !== 'ok' || whole.status !== 'ok') continue;
    if (part.value === null || whole.value === null) continue;
    // A small overshoot is measurement skew; a large one is a broken source.
    if (part.value > whole.value * 1.02) {
      const note = `${partId} (${part.value}) exceeds ${wholeId} (${whole.value}); both are unreliable`;
      for (const id of [partId, wholeId]) {
        const index = out.findIndex((r) => r.metric === id);
        const original = out[index];
        if (index >= 0 && original) {
          out[index] = unknownReading({
            metric: id,
            timestampMs: original.timestampMs,
            source: original.source,
            status: 'invalid',
            note,
            fidelity: original.fidelity,
          });
        }
      }
    }
  }

  return out;
}
