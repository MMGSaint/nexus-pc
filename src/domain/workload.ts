/**
 * Workload classification.
 *
 * NEXUS observes the machine; it does not know what the user intends. The
 * classifier therefore always reports a confidence and always lists the
 * alternatives it considered. `unknown` is a legitimate, common answer.
 *
 * Vesper may supply a declared context (see `ContextHint`). That is treated as
 * evidence, never as truth: NEXUS still checks it against what it can observe
 * and reports the disagreement rather than silently deferring.
 */

import type { Fidelity } from '../core/fidelity.js';

export const WORKLOAD_CLASSES = [
  'idle',
  'desktop',
  'gaming',
  'streaming',
  'development',
  'ai_inference',
  'gpu_bound',
  'cpu_bound',
  'mixed',
  'unknown',
] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

/**
 * Known application identities are labels for profile selection, not authority.
 * Matching is case-insensitive substring matching against observed executable names.
 */
export const APPLICATION_HINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  squad: Object.freeze(['squadgame', 'squad']),
  'where-winds-meet': Object.freeze(['wherewindsmeet']),
  vrchat: Object.freeze(['vrchat']),
  'red-dead-redemption-2': Object.freeze(['rdr2']),
  'cyberpunk-2077': Object.freeze(['cyberpunk']),
  'helldivers-2': Object.freeze(['helldivers']),
  'elden-ring': Object.freeze(['eldenring']),
});

export interface ProcessObservation {
  readonly name: string;
  readonly pid: number | null;
  readonly cpuPercent: number | null;
  readonly workingSetBytes: number | null;
  readonly isForeground: boolean | null;
}

export interface WorkloadSignals {
  readonly timestampMs: number;
  readonly cpuUtilization: number | null;
  readonly gpuUtilization: number | null;
  readonly vramUsedBytes: number | null;
  readonly vramTotalBytes: number | null;
  readonly memoryUsedRatio: number | null;
  readonly processes: readonly ProcessObservation[];
  readonly fidelity: Fidelity;
}

export interface ClassificationCandidate {
  readonly workload: WorkloadClass;
  /** 0..1 */
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface WorkloadClassification {
  /** Stable application ids detected from executable-name heuristics. */
  readonly detectedApplicationIds?: readonly string[];
  readonly timestampMs: number;
  readonly workload: WorkloadClass;
  /** 0..1. Below `MIN_ACTIONABLE_CONFIDENCE` NEXUS refuses to act on it. */
  readonly confidence: number;
  readonly candidates: readonly ClassificationCandidate[];
  readonly fidelity: Fidelity;
  /** Signals that were missing, which is why confidence is bounded. */
  readonly missingSignals: readonly string[];
  /** Context declared by an external orchestrator, if any. */
  readonly declaredContext?: ContextHint;
  /** True when the declared context and the observed evidence disagree. */
  readonly contextConflict: boolean;
  readonly explanation: string;
}

/**
 * Intent supplied by Vesper — "the user said they are about to stream".
 * NEXUS stores who said it and when, and never elevates a hint to a fact.
 */
export interface ContextHint {
  readonly workload: WorkloadClass;
  readonly declaredBy: string;
  readonly declaredAtMs: number;
  readonly note?: string;
  /** How long the hint stays relevant. Hints expire; they do not persist. */
  readonly ttlMs: number;
}

/**
 * Confidence floor for acting. A classification below this may be reported but
 * must not, on its own, justify changing the machine.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.6;

export function isActionable(c: WorkloadClassification): boolean {
  return c.workload !== 'unknown' && c.confidence >= MIN_ACTIONABLE_CONFIDENCE;
}

export function hintIsFresh(hint: ContextHint, nowMs: number): boolean {
  return nowMs >= hint.declaredAtMs && nowMs - hint.declaredAtMs <= hint.ttlMs;
}
