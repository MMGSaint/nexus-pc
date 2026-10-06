import type { Fidelity } from '../core/fidelity.js';
import type { Reading } from '../domain/telemetry.js';
import { reading } from '../domain/telemetry.js';
import type { FramePerformanceSummary } from './stats.js';

export type FrameTruthDecision = 'benefit' | 'no_measurable_benefit' | 'regression' | 'insufficient_evidence';

export interface FrameTruth {
  readonly capturedAtMs: number;
  readonly fidelity: Fidelity;
  readonly summary: FramePerformanceSummary;
  readonly processId?: number;
  readonly processName?: string;
}

export interface FrameBenefitPolicy {
  readonly minImprovementPercent: number;
  readonly maxRegressionPercent: number;
  readonly minSamples: number;
}

export interface FrameBenefitResult {
  readonly decision: FrameTruthDecision;
  readonly scorePercent: number | null;
  readonly reason: string;
}

const DEFAULT_POLICY: FrameBenefitPolicy = Object.freeze({
  minImprovementPercent: 1,
  maxRegressionPercent: 1,
  minSamples: 120,
});

function relativeDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  return ((before - after) / Math.abs(before)) * 100;
}

export function requireFrameBenefit(
  before: FrameTruth,
  after: FrameTruth,
  policy: Partial<FrameBenefitPolicy> = {},
): FrameBenefitResult {
  const p = { ...DEFAULT_POLICY, ...policy };
  if (before.fidelity !== 'live' || after.fidelity !== 'live' || before.summary.sampleCount < p.minSamples || after.summary.sampleCount < p.minSamples) {
    return { decision: 'insufficient_evidence', scorePercent: null, reason: 'Frame-truth evidence is not live or does not contain enough samples on both sides.' };
  }
  const candidates: number[] = [];
  const average = relativeDelta(before.summary.averageFrameTimeMs, after.summary.averageFrameTimeMs);
  const p95 = relativeDelta(before.summary.p95FrameTimeMs, after.summary.p95FrameTimeMs);
  const p99 = relativeDelta(before.summary.p99FrameTimeMs, after.summary.p99FrameTimeMs);
  const stddev = relativeDelta(before.summary.frameTimeStdDevMs, after.summary.frameTimeStdDevMs);
  if (before.summary.fps1PercentLow !== null && after.summary.fps1PercentLow !== null && before.summary.fps1PercentLow !== 0) {
    candidates.push(((after.summary.fps1PercentLow - before.summary.fps1PercentLow) / Math.abs(before.summary.fps1PercentLow)) * 100);
  }
  if (before.summary.fps0_1PercentLow !== null && after.summary.fps0_1PercentLow !== null && before.summary.fps0_1PercentLow !== 0) {
    candidates.push(((after.summary.fps0_1PercentLow - before.summary.fps0_1PercentLow) / Math.abs(before.summary.fps0_1PercentLow)) * 100);
  }
  for (const value of [average, p95, p99, stddev]) if (value !== null) candidates.push(value);
  if (!candidates.length) return { decision: 'insufficient_evidence', scorePercent: null, reason: 'No comparable frame-time or low-FPS measurements were available.' };
  const score = candidates.reduce((a, b) => a + b, 0) / candidates.length;
  const droppedRegression = before.summary.droppedFramesKnown && after.summary.droppedFramesKnown && after.summary.droppedFrames > before.summary.droppedFrames;
  if (droppedRegression || score <= -Math.abs(p.maxRegressionPercent)) {
    return { decision: 'regression', scorePercent: score, reason: droppedRegression ? 'Dropped frames increased after the change.' : 'Composite frame-quality score regressed by ' + score.toFixed(2) + '%.' };
  }
  if (score >= Math.abs(p.minImprovementPercent)) return { decision: 'benefit', scorePercent: score, reason: 'Composite frame-quality score improved by ' + score.toFixed(2) + '%.' };
  return { decision: 'no_measurable_benefit', scorePercent: score, reason: 'Composite frame-quality change was only ' + score.toFixed(2) + '%, below the ' + p.minImprovementPercent + '% benefit floor.' };
}

/** Convert PresentMon evidence into the NEXUS telemetry vocabulary. */
export function frameTruthReadings(truth: FrameTruth): readonly Reading[] {
  const s = truth.summary;
  const common = {
    timestampMs: truth.capturedAtMs,
    source: 'presentmon',
    fidelity: truth.fidelity,
    confidence: truth.fidelity === 'live' ? 1 : 0.5,
  } as const;

  const values: Array<readonly ['frame.time' | 'frame.fps' | 'frame.1pct_low' | 'frame.0_1pct_low' | 'frame.time.p95' | 'frame.time.p99' | 'frame.time.stddev' | 'frame.dropped', number]> = [
    ['frame.time', s.averageFrameTimeMs],
    ['frame.fps', s.fps],
    ['frame.1pct_low', s.fps1PercentLow],
    ['frame.0_1pct_low', s.fps0_1PercentLow],
    ['frame.time.p95', s.p95FrameTimeMs],
    ['frame.time.p99', s.p99FrameTimeMs],
    ['frame.time.stddev', s.frameTimeStdDevMs],
    ['frame.dropped', s.droppedFrames],
  ];
  return values
    .filter(([, value]) => value !== null && Number.isFinite(value))
    .map(([metric, value]) => reading({ ...common, metric, value }));
}
