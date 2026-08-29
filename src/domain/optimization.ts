/**
 * The optimization pipeline's data model.
 *
 *   OBSERVE -> BASELINE -> PROPOSE -> VALIDATE -> APPLY -> MEASURE -> KEEP/ROLLBACK
 *
 * A proposal is a *request*. It carries no authority of its own: origin is
 * recorded for audit and for policy, never as a permission grant. There is
 * deliberately no field on any type in this file by which a caller could
 * assert elevated rights, disable a check, or mark itself trusted.
 */

import type { Fidelity } from '../core/fidelity.js';
import type { ControlId, ControlValue } from './control.js';
import type { WorkloadClass } from './workload.js';

/**
 * Where a request came from. Used for audit and for policy that *restricts*
 * (e.g. only `user` may confirm a restricted control). No origin ever widens
 * what the safety kernel permits.
 */
export const REQUEST_ORIGINS = ['internal', 'user', 'vesper'] as const;
export type RequestOrigin = (typeof REQUEST_ORIGINS)[number];

export interface ProposedChange {
  readonly control: ControlId;
  readonly targetValue: ControlValue;
  readonly rationale: string;
  /** What the change is expected to do, in the proposer's own words. */
  readonly expectedEffect: string;
}

export interface OptimizationProposal {
  readonly id: string;
  readonly createdAtMs: number;
  readonly origin: RequestOrigin;
  /** Free-form identifier of the requester, for audit. Not a credential. */
  readonly requestedBy: string;
  readonly workload: WorkloadClass;
  readonly changes: readonly ProposedChange[];
  readonly profileId?: string;
  readonly notes?: string;
  /**
   * Present only when a human explicitly confirmed a `restricted` control.
   * The kernel checks that this was produced by a `user`-origin request.
   */
  readonly confirmation?: HumanConfirmation;
}

export interface HumanConfirmation {
  readonly confirmedAtMs: number;
  readonly controls: readonly ControlId[];
  readonly acknowledgement: string;
}

export const FINDING_SEVERITIES = ['info', 'warning', 'blocking'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface SafetyFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly control?: ControlId;
}

export const SAFETY_DECISIONS = ['allow', 'requires-confirmation', 'reject'] as const;
export type SafetyDecision = (typeof SAFETY_DECISIONS)[number];

export interface SafetyVerdict {
  readonly decision: SafetyDecision;
  readonly findings: readonly SafetyFinding[];
  /** Changes the kernel is willing to permit, possibly fewer than requested. */
  readonly permitted: readonly ProposedChange[];
  readonly evaluatedAtMs: number;
  /** Hash of the policy that produced the verdict, for audit reproducibility. */
  readonly policyDigest: string;
}

/** Reasons NEXUS legitimately decides to do nothing. Doing nothing is a result. */
export const NO_ACTION_REASONS = [
  'already_optimal',
  'negligible_benefit',
  'low_confidence',
  'unsafe',
  'capability_unavailable',
  'cost_exceeds_benefit',
  'observation_only',
  'degraded',
  'cooldown',
  'no_proposal_generated',
] as const;
export type NoActionReason = (typeof NO_ACTION_REASONS)[number];

export const OPTIMIZATION_STATUSES = [
  'no_action',
  'rejected',
  'requires_confirmation',
  'applied_kept',
  'applied_rolled_back',
  'applied_unverified',
  'failed',
] as const;
export type OptimizationStatus = (typeof OPTIMIZATION_STATUSES)[number];

export interface AppliedChange {
  readonly control: ControlId;
  readonly previousValue: ControlValue | null;
  readonly appliedValue: ControlValue;
  readonly verified: boolean;
  readonly appliedAtMs: number;
  readonly note?: string;
}

export interface MeasurementDelta {
  readonly metric: string;
  readonly before: number | null;
  readonly after: number | null;
  readonly delta: number | null;
  readonly unit: string;
  /** True when the change is larger than the metric's noise floor. */
  readonly significant: boolean;
}

export interface OptimizationOutcome {
  readonly id: string;
  readonly proposalId: string | null;
  readonly status: OptimizationStatus;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  /**
   * Provenance of the whole outcome. An outcome produced through a mock
   * actuator is `mocked`, never `live`, no matter how it is transported.
   */
  readonly fidelity: Fidelity;
  readonly workload: WorkloadClass;
  readonly noActionReason?: NoActionReason;
  readonly verdict?: SafetyVerdict;
  readonly appliedChanges: readonly AppliedChange[];
  readonly rolledBack: boolean;
  readonly checkpointId: string | null;
  readonly measurements: readonly MeasurementDelta[];
  readonly summary: string;
  readonly findings: readonly SafetyFinding[];
}

/**
 * Structured feedback for an orchestrator such as Vesper: what was asked, what
 * was observed, and what actually happened. Vesper may learn from this; NEXUS
 * does not mutate its own safety policy from it.
 */
export interface OutcomeReport {
  readonly outcomeId: string;
  readonly recommendation: string;
  readonly observed: string;
  readonly result: 'benefit' | 'no_measurable_benefit' | 'regression' | 'not_applied' | 'unverified';
  readonly measurements: readonly MeasurementDelta[];
  readonly fidelity: Fidelity;
}
