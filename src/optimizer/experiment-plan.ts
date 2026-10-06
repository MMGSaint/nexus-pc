import type { ControlId, ControlValue } from '../domain/control.js';
import {
  mean,
  statisticallyCredibleImprovement,
  type BootstrapInterval,
} from './stats.js';
import { canonicalJson } from '../core/canonical-json.js';
import { createHash } from 'node:crypto';

export interface ExperimentDimension {
  readonly control: ControlId;
  readonly candidates: readonly ControlValue[];
}

export interface ExperimentCandidate {
  readonly id: string;
  readonly values: Readonly<Record<string, ControlValue>>;
}

export interface ExperimentFingerprintInput {
  readonly machine: {
    readonly cpu: string | null;
    readonly gpu: string | null;
    readonly memoryBytes: number | null;
  };
  readonly os: {
    readonly version: string | null;
    readonly build: string | null;
  };
  readonly platform: {
    readonly driverVersion: string | null;
    readonly biosVersion: string | null;
    readonly chipsetVersion: string | null;
  };
  readonly workload: {
    readonly applicationId: string;
    readonly gameBuild: string | null;
  };
}

export interface ExperimentFingerprint {
  readonly algorithm: 'sha256';
  readonly value: string;
  readonly inputs: ExperimentFingerprintInput;
}

export interface ExperimentDecision {
  readonly keep: boolean;
  readonly score: BootstrapInterval & { readonly keep: boolean };
  readonly stabilityRegression: boolean;
  readonly explanation: string;
}

export function fingerprintExperiment(input: ExperimentFingerprintInput): ExperimentFingerprint {
  const value = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return { algorithm: 'sha256', value, inputs: input };
}

export function makeCandidateGrid(
  dimensions: readonly ExperimentDimension[],
  maxTrials = 32,
): readonly ExperimentCandidate[] {
  const bounded = Math.max(1, Math.min(256, Math.floor(maxTrials)));
  const ordered = [...dimensions].sort((a, b) => a.control.localeCompare(b.control));
  const out: ExperimentCandidate[] = [];

  const visit = (index: number, values: Record<string, ControlValue>): void => {
    if (out.length >= bounded) return;
    if (index >= ordered.length) {
      const serialized = canonicalJson(values);
      out.push({
        id: `candidate-${createHash('sha256').update(serialized).digest('hex').slice(0, 12)}`,
        values: Object.freeze({ ...values }),
      });
      return;
    }
    const dimension = ordered[index]!;
    const candidates = [...new Set(dimension.candidates.map((value) => canonicalJson(value)))]
      .map((value) => JSON.parse(value) as ControlValue);
    for (const candidate of candidates) {
      values[dimension.control] = candidate;
      visit(index + 1, values);
      if (out.length >= bounded) break;
    }
    delete values[dimension.control];
  };

  if (ordered.length === 0) return Object.freeze([{ id: 'candidate-empty', values: Object.freeze({}) }]);
  visit(0, {});
  return Object.freeze(out);
}

/**
 * Interleaved A/B schedule. Candidate 0 is the reference/baseline.
 * Every trial begins and ends with the baseline so drift in thermals or scene
 * progression is less likely to masquerade as a setting effect.
 */
export function interleaveBaseline(
  candidate: ExperimentCandidate,
  blocks = 3,
): readonly string[] {
  const count = Math.max(1, Math.min(16, Math.floor(blocks)));
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push('baseline', candidate.id);
  }
  out.push('baseline');
  return Object.freeze(out);
}

/**
 * Decide a candidate using paired/interleaved percent deltas. The interval must
 * clear both zero and a practical effect floor; stability regressions override
 * the statistical score.
 */
export function decideExperiment(
  deltaPercent: readonly number[],
  options: {
    readonly practicalThresholdPercent?: number;
    readonly seed?: number;
    readonly stabilityRegression?: boolean;
  } = {},
): ExperimentDecision {
  const score = statisticallyCredibleImprovement(deltaPercent, {
    practicalThresholdPercent: Math.max(0.1, options.practicalThresholdPercent ?? 1),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const stabilityRegression = options.stabilityRegression === true;
  return {
    keep: score.keep && !stabilityRegression,
    score,
    stabilityRegression,
    explanation: stabilityRegression
      ? 'The measured candidate showed a stability regression; statistical performance improvement cannot override it.'
      : score.keep
        ? `The candidate cleared the practical threshold and its confidence interval excludes zero (mean ${mean(deltaPercent)?.toFixed(2)}%).`
        : 'The candidate did not clear the practical improvement threshold with a confidence interval that excludes zero.',
  };
}
