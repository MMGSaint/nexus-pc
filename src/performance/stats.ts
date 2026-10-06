/**
 * Pure frame-performance statistics.
 *
 * This module deliberately contains no process, ETW or filesystem code. It can
 * therefore be used by PresentMon capture, A/B trials, the UI and tests without
 * creating a new trust boundary.
 */

export type FrameType = 'application' | 'repeated' | 'amd_afmf' | 'intel_xefg' | 'unknown';

export interface FrameSample {
  readonly frameTimeMs: number;
  readonly gpuTimeMs?: number;
  readonly cpuBusyMs?: number;
  readonly displayLatencyMs?: number;
  readonly presentIntervalMs?: number;
  readonly displayIntervalMs?: number;
  readonly frameType?: FrameType;
  readonly dropped?: boolean;
}

export interface FramePerformanceSummary {
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly averageFrameTimeMs: number | null;
  readonly fps: number | null;
  readonly fps1PercentLow: number | null;
  readonly fps0_1PercentLow: number | null;
  readonly p95FrameTimeMs: number | null;
  readonly p99FrameTimeMs: number | null;
  readonly frameTimeStdDevMs: number | null;
  readonly presentIntervalMs: number | null;
  readonly displayIntervalMs: number | null;
  readonly displayedFps: number | null;
  readonly presentedFps: number | null;
  readonly applicationFrameCount: number;
  readonly applicationFps: number | null;
  readonly displayLatencyP95Ms: number | null;
  readonly generatedFrameCount: number;
  readonly generatedFrameFraction: number | null;
  readonly afmfFrameCount: number;
  readonly droppedFrames: number;
  readonly droppedFramesKnown: boolean;
}

export interface BootstrapInterval {
  readonly estimate: number | null;
  readonly low: number | null;
  readonly high: number | null;
  readonly samples: number;
  readonly resamples: number;
}

function finite(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v));
}

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = [...finite(values)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const clamped = Math.max(0, Math.min(1, p));
  const index = (sorted.length - 1) * clamped;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo] ?? null;
  const a = sorted[lo];
  const b = sorted[hi];
  return a === undefined || b === undefined ? null : a + (b - a) * (index - lo);
}

export function mean(values: readonly number[]): number | null {
  const v = finite(values);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function standardDeviation(values: readonly number[]): number | null {
  const v = finite(values);
  if (v.length < 2) return v.length === 1 ? 0 : null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((sum, x) => sum + (x - m) ** 2, 0) / (v.length - 1);
  return Math.sqrt(variance);
}

function lowFps(frameTimes: readonly number[], fraction: number): number | null {
  const v = finite(frameTimes).sort((a, b) => b - a);
  if (!v.length) return null;
  const count = Math.max(1, Math.ceil(v.length * fraction));
  const tail = v.slice(0, count);
  const worstMean = mean(tail);
  return worstMean && worstMean > 0 ? 1000 / worstMean : null;
}

export function summarizeFrames(samples: readonly FrameSample[]): FramePerformanceSummary {
  const frameTimes = finite(samples.map((s) => s.frameTimeMs).filter((x) => x >= 0));
  const durationMs = frameTimes.reduce((sum, value) => sum + value, 0);
  const dropped = samples.filter((s) => s.dropped === true).length;
  const droppedKnown = samples.some((s) => s.dropped !== undefined);
  const avg = mean(frameTimes);
  const presentIntervals = samples.map((s) => s.presentIntervalMs).filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0);
  const displayIntervals = samples.map((s) => s.displayIntervalMs).filter((v): v is number => v !== undefined && Number.isFinite(v) && v > 0);
  const latencies = samples.map((s) => s.displayLatencyMs).filter((v): v is number => v !== undefined && Number.isFinite(v) && v >= 0);
  const generated = samples.filter((s) => s.frameType === 'amd_afmf' || s.frameType === 'intel_xefg').length;
  const afmf = samples.filter((s) => s.frameType === 'amd_afmf').length;
  const applicationSamples = samples.filter((s) => s.frameType === undefined || s.frameType === 'unknown' || s.frameType === 'application');
  const applicationTimes = applicationSamples.map((s) => s.frameTimeMs).filter((v) => Number.isFinite(v) && v > 0);

  return {
    sampleCount: frameTimes.length,
    durationMs,
    averageFrameTimeMs: avg,
    fps: avg && avg > 0 ? 1000 / avg : null,
    fps1PercentLow: lowFps(frameTimes, 0.01),
    fps0_1PercentLow: lowFps(frameTimes, 0.001),
    p95FrameTimeMs: percentile(frameTimes, 0.95),
    p99FrameTimeMs: percentile(frameTimes, 0.99),
    frameTimeStdDevMs: standardDeviation(frameTimes),
    presentIntervalMs: mean(presentIntervals),
    displayIntervalMs: mean(displayIntervals),
    displayedFps: (() => { const m = mean(displayIntervals); return m && m > 0 ? 1000 / m : null; })(),
    presentedFps: (() => { const m = mean(presentIntervals); return m && m > 0 ? 1000 / m : null; })(),
    applicationFrameCount: applicationTimes.length,
    applicationFps: (() => { const m = mean(applicationTimes); return m && m > 0 ? 1000 / m : null; })(),
    displayLatencyP95Ms: percentile(latencies, 0.95),
    generatedFrameCount: generated,
    generatedFrameFraction: samples.length > 0 ? generated / samples.length : null,
    afmfFrameCount: afmf,
    droppedFrames: dropped,
    droppedFramesKnown: droppedKnown,
  };
}

/**
 * Deterministic bootstrap interval when a caller supplies a seed. A/B decisions
 * should use paired or interleaved data in the higher-level experiment layer;
 * this helper is generic and intentionally does not assume normality.
 */
export function bootstrapInterval(
  values: readonly number[],
  statistic: (sample: readonly number[]) => number | null,
  options: { readonly resamples?: number; readonly alpha?: number; readonly seed?: number } = {},
): BootstrapInterval {
  const source = finite(values);
  if (!source.length) return { estimate: null, low: null, high: null, samples: 0, resamples: 0 };
  const resamples = Math.max(100, Math.min(20_000, options.resamples ?? 2_000));
  const alpha = Math.max(0.001, Math.min(0.2, options.alpha ?? 0.05));
  let state = (options.seed ?? 0x9e3779b9) >>> 0;
  const rand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };

  const estimates: number[] = [];
  for (let i = 0; i < resamples; i += 1) {
    const sample = new Array<number>(source.length);
    for (let j = 0; j < source.length; j += 1) {
      sample[j] = source[Math.floor(rand() * source.length)]!;
    }
    const estimate = statistic(sample);
    if (estimate !== null && Number.isFinite(estimate)) estimates.push(estimate);
  }

  const estimate = statistic(source);
  if (!estimates.length || estimate === null) {
    return { estimate, low: null, high: null, samples: source.length, resamples: estimates.length };
  }
  estimates.sort((a, b) => a - b);
  const low = percentile(estimates, alpha / 2);
  const high = percentile(estimates, 1 - alpha / 2);
  return { estimate, low, high, samples: source.length, resamples: estimates.length };
}

/**
 * A safe decision rule for a scalar improvement:
 * - CI must exclude zero;
 * - the point estimate must clear a caller-provided practical threshold.
 */
export function statisticallyCredibleImprovement(
  deltaPercent: readonly number[],
  options: { readonly practicalThresholdPercent?: number; readonly seed?: number } = {},
): BootstrapInterval & { readonly keep: boolean } {
  const ci = bootstrapInterval(
    deltaPercent,
    mean,
    options.seed === undefined ? {} : { seed: options.seed },
  );
  const threshold = Math.abs(options.practicalThresholdPercent ?? 1);
  const keep =
    ci.estimate !== null &&
    ci.low !== null &&
    ci.high !== null &&
    ci.low > threshold;
  return { ...ci, keep };
}
