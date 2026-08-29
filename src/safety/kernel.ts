/**
 * The safety kernel.
 *
 * Every write to the machine passes through `evaluate`. The kernel is a pure
 * function of (proposal, context, policy): no I/O, no clock of its own, no
 * network, no model. That is deliberate — it is the component that must remain
 * predictable when everything above it is not.
 *
 * Two rules shape the whole design:
 *
 *  - Verdicts are all-or-nothing. Partially applying a proposal produces a
 *    state that is harder to reason about and harder to roll back, so a single
 *    blocking finding rejects the entire proposal. Filtering a *profile* down
 *    to what a machine supports happens above the kernel, before a proposal is
 *    ever built.
 *  - When the kernel cannot establish that a change is safe, it refuses.
 *    Missing thermal telemetry is not "probably fine"; it is a blocking
 *    finding for any control whose policy depends on temperature.
 */

import type { Fidelity } from '../core/fidelity.js';
import type { CapabilityId } from '../domain/capability.js';
import type { CapabilityRecord } from '../domain/capability.js';
import type { ControlId, ControlValue } from '../domain/control.js';
import { valueMatchesSpec, describeValueSpec } from '../domain/control.js';
import type { RunState } from '../domain/health.js';
import type {
  OptimizationProposal,
  ProposedChange,
  RequestOrigin,
  SafetyFinding,
  SafetyVerdict,
} from '../domain/optimization.js';
import type { TelemetrySnapshot } from '../domain/telemetry.js';
import { isKnown } from '../domain/telemetry.js';
import { getControl } from './controls.js';
import type { SafetyPolicy } from './policy.js';
import { policyDigest } from './policy.js';
import { scanForAuthorityClaims } from './guards.js';

export interface AppliedRecord {
  readonly control: ControlId;
  readonly appliedAtMs: number;
}

export interface SafetyContext {
  readonly nowMs: number;
  readonly runState: RunState;
  readonly capabilities: ReadonlyMap<CapabilityId, CapabilityRecord>;
  /** Most recent telemetry, or null when telemetry is not producing. */
  readonly telemetry: TelemetrySnapshot | null;
  readonly baselineAvailable: boolean;
  /** Applications inside the rolling window, used for rate limiting. */
  readonly recentApplications: readonly AppliedRecord[];
  /**
   * Fidelity of the actuator that would perform each change. A mocked actuator
   * does not block the verdict — simulation is a legitimate mode — but it is
   * recorded so the resulting outcome can never be reported as live.
   */
  readonly actuatorFidelity: (control: ControlId) => Fidelity;
}

const RUN_STATES_PERMITTING_WRITES: ReadonlySet<RunState> = new Set<RunState>(['ready', 'degraded']);

export class SafetyKernel {
  private readonly policy: SafetyPolicy;
  private readonly digest: string;

  constructor(policy: SafetyPolicy) {
    this.policy = policy;
    this.digest = policyDigest(policy);
  }

  get policyDigest(): string {
    return this.digest;
  }

  /** Read-only view of the effective policy, for health and audit output. */
  get effectivePolicy(): SafetyPolicy {
    return this.policy;
  }

  /**
   * Gate a checkpoint restore.
   *
   * Restoring is a write, so it goes through the kernel like any other write —
   * previously it did not, which meant `observationOnly` and the run-state gate
   * could both be routed around by asking for a rollback instead of an
   * optimization.
   *
   * It is deliberately gated *differently* from an optimization rather than
   * identically: putting a setting back is the safe direction, so it stays
   * available while NEXUS is degraded or observation-only, and it is not
   * subject to cooldowns or the hourly rate limit — those exist to stop a
   * control being churned, and refusing a revert because of them would be
   * precisely the wrong answer. What it is not exempt from is the absolute
   * switches: `observationOnly`, and the rule that only a human can write
   * while NEXUS is not accepting optimizations.
   */
  evaluateRollback(request: RollbackRequest, context: SafetyContext): SafetyVerdict {
    const findings: SafetyFinding[] = [];
    const block = (code: string, message: string, control?: ControlId): void => {
      findings.push(control === undefined
        ? { code, severity: 'blocking', message }
        : { code, severity: 'blocking', message, control });
    };

    const authority = scanForAuthorityClaims(request);
    if (!authority.clean) {
      block('AUTHORITY_CLAIM_PRESENT', 'Rollback request contains fields that assert privilege.');
    }

    if (this.policy.global.observationOnly) {
      block('OBSERVATION_ONLY', 'NEXUS is configured observation-only; it will not write to this machine at all.');
    }

    if (!RUN_STATES_PERMITTING_ROLLBACK.has(context.runState)) {
      block('RUNTIME_NOT_READY', `NEXUS run state is "${context.runState}"; a rollback cannot be performed.`);
    } else if (context.runState === 'observation_only' && request.origin !== 'user') {
      // A human may revert while NEXUS is observing. An orchestrator may not:
      // observation mode means NEXUS does not act on anyone else's say-so.
      block(
        'ORIGIN_NOT_PERMITTED',
        `NEXUS is observation-only; a ${request.origin} request cannot write to this machine. A rollback asked for directly by the user is still permitted.`,
      );
    }

    if (request.controls.length === 0) {
      block('EMPTY_ROLLBACK', 'The checkpoint captured no restorable control.');
    }

    for (const control of request.controls) {
      const descriptor = getControl(control);
      if (!descriptor) {
        block('CONTROL_UNKNOWN', `Checkpoint refers to "${control}", which is not a control NEXUS knows about.`, control);
        continue;
      }
      if (descriptor.safetyClass === 'prohibited') {
        block('CONTROL_PROHIBITED', `"${descriptor.name}" is prohibited and cannot be written, even to restore it.`, control);
      } else if (descriptor.access !== 'read-write') {
        block('CONTROL_READ_ONLY', `"${descriptor.name}" is read-only.`, control);
      }
    }

    const blocking = findings.filter((f) => f.severity === 'blocking');
    return {
      decision: blocking.length > 0 ? 'reject' : 'allow',
      findings,
      permitted: [],
      evaluatedAtMs: context.nowMs,
      policyDigest: this.digest,
    };
  }

  evaluate(proposal: OptimizationProposal, context: SafetyContext): SafetyVerdict {
    const findings: SafetyFinding[] = [];
    let needsConfirmation = false;

    const block = (code: string, message: string, control?: ControlId): void => {
      findings.push(control === undefined
        ? { code, severity: 'blocking', message }
        : { code, severity: 'blocking', message, control });
    };
    const note = (code: string, message: string, control?: ControlId): void => {
      findings.push(control === undefined
        ? { code, severity: 'info', message }
        : { code, severity: 'info', message, control });
    };

    /* ---------------------------------------------------- global gating */

    const authority = scanForAuthorityClaims(proposal);
    if (!authority.clean) {
      block(
        'AUTHORITY_CLAIM_PRESENT',
        `Request contains fields that assert privilege (${authority.offendingPaths.join(', ')}). NEXUS grants no authority on request.`,
      );
    }

    if (this.policy.global.observationOnly) {
      block('OBSERVATION_ONLY', 'NEXUS is in observation-only mode; no changes are applied.');
    }

    if (!RUN_STATES_PERMITTING_WRITES.has(context.runState)) {
      block('RUNTIME_NOT_READY', `NEXUS run state is "${context.runState}"; changes are not accepted.`);
    }

    if (proposal.changes.length === 0) {
      block('EMPTY_PROPOSAL', 'Proposal contains no changes.');
    }

    if (proposal.changes.length > this.policy.global.maxChangesPerProposal) {
      block(
        'TOO_MANY_CHANGES',
        `Proposal has ${proposal.changes.length} changes; the limit is ${this.policy.global.maxChangesPerProposal}.`,
      );
    }

    const seen = new Set<ControlId>();
    for (const change of proposal.changes) {
      if (seen.has(change.control)) {
        block('DUPLICATE_CONTROL', `Control "${change.control}" appears more than once.`, change.control);
      }
      seen.add(change.control);
    }

    const windowStart = context.nowMs - 3_600_000;
    const appliedThisHour = context.recentApplications.filter((r) => r.appliedAtMs >= windowStart).length;
    if (appliedThisHour + proposal.changes.length > this.policy.global.maxAppliedChangesPerHour) {
      block(
        'RATE_LIMIT',
        `Applying ${proposal.changes.length} more change(s) would exceed the limit of ${this.policy.global.maxAppliedChangesPerHour} per hour (${appliedThisHour} already applied).`,
      );
    }

    /* --------------------------------------------------- per-control gating */

    for (const change of proposal.changes) {
      const perChange = this.evaluateChange(change, proposal, context);
      findings.push(...perChange.findings);
      if (perChange.needsConfirmation) needsConfirmation = true;
    }

    const blocking = findings.filter((f) => f.severity === 'blocking');
    const decision: SafetyVerdict['decision'] =
      blocking.length > 0 ? 'reject' : needsConfirmation ? 'requires-confirmation' : 'allow';

    if (decision === 'allow') {
      note('ALLOWED', `${proposal.changes.length} change(s) permitted by policy ${this.digest}.`);
    }

    return {
      decision,
      findings,
      permitted: decision === 'allow' ? proposal.changes : [],
      evaluatedAtMs: context.nowMs,
      policyDigest: this.digest,
    };
  }

  private evaluateChange(
    change: ProposedChange,
    proposal: OptimizationProposal,
    context: SafetyContext,
  ): { findings: SafetyFinding[]; needsConfirmation: boolean } {
    const findings: SafetyFinding[] = [];
    let needsConfirmation = false;
    const control = change.control;

    const block = (code: string, message: string): void => {
      findings.push({ code, severity: 'blocking', message, control });
    };
    const note = (code: string, message: string): void => {
      findings.push({ code, severity: 'info', message, control });
    };

    const descriptor = getControl(control);
    if (!descriptor) {
      block('CONTROL_UNKNOWN', `No control named "${control}" exists. NEXUS cannot create controls on request.`);
      return { findings, needsConfirmation };
    }

    if (descriptor.safetyClass === 'prohibited') {
      block(
        'CONTROL_PROHIBITED',
        `"${descriptor.name}" is prohibited and cannot be changed by NEXUS under any policy. ${descriptor.description}`,
      );
      return { findings, needsConfirmation };
    }

    if (descriptor.access !== 'read-write') {
      block('CONTROL_READ_ONLY', `"${descriptor.name}" is read-only.`);
      return { findings, needsConfirmation };
    }

    const policy = this.policy.controls[control];
    if (!policy || !policy.allowed) {
      block('CONTROL_NOT_PERMITTED', `Policy does not permit writes to "${descriptor.name}".`);
      return { findings, needsConfirmation };
    }

    /* ------------------------------------------------------------- value */

    if (!valueMatchesSpec(descriptor.valueSpec, change.targetValue)) {
      block(
        'VALUE_OUT_OF_SPEC',
        `Value ${JSON.stringify(change.targetValue)} is not valid for "${descriptor.name}" (expected ${describeValueSpec(descriptor.valueSpec)}).`,
      );
      return { findings, needsConfirmation };
    }

    if (policy.range && typeof change.targetValue === 'number') {
      if (change.targetValue < policy.range.min || change.targetValue > policy.range.max) {
        block(
          'VALUE_OUT_OF_POLICY',
          `Value ${change.targetValue} is outside the policy range ${policy.range.min}..${policy.range.max} for "${descriptor.name}".`,
        );
      }
    }

    if (policy.allowedValues && typeof change.targetValue === 'string') {
      if (!policy.allowedValues.includes(change.targetValue)) {
        // Not fatal on its own: a human may confirm a value the policy keeps
        // behind confirmation, provided the descriptor itself permits it.
        needsConfirmation = true;
        note(
          'VALUE_REQUIRES_CONFIRMATION',
          `Value "${change.targetValue}" is outside the automatic set (${policy.allowedValues.join(', ')}) and needs explicit confirmation.`,
        );
      }
    }

    /* ------------------------------------------------------ capabilities */

    for (const capabilityId of descriptor.requiresCapabilities) {
      const record = context.capabilities.get(capabilityId);
      if (!record) {
        block('CAPABILITY_UNKNOWN', `Capability "${capabilityId}" has not been probed; cannot establish that this change is possible.`);
        continue;
      }
      if (record.state === 'unsupported') {
        block('CAPABILITY_UNSUPPORTED', `Capability "${capabilityId}" is not supported on this machine: ${record.detail}`);
      } else if (record.state === 'unavailable') {
        block('CAPABILITY_UNAVAILABLE', `Capability "${capabilityId}" is unavailable: ${record.detail}`);
      } else if (record.state === 'unverified') {
        block('CAPABILITY_UNVERIFIED', `Capability "${capabilityId}" has not been verified on this machine. NEXUS does not act on unverified capabilities.`);
      } else if (record.state === 'mocked') {
        note('CAPABILITY_MOCKED', `Capability "${capabilityId}" is mocked; any outcome will be reported as mocked, not live.`);
      }
    }

    const actuator = context.actuatorFidelity(control);
    if (actuator !== 'live') {
      note('ACTUATOR_NOT_LIVE', `The actuator for "${descriptor.name}" is ${actuator}; the outcome cannot be reported as live.`);
    }

    /* --------------------------------------------------------- evidence */

    if (descriptor.evidenceLevel === 'contested' && proposal.origin !== 'user') {
      block(
        'CONTESTED_EVIDENCE',
        `"${descriptor.name}" has contested evidence of benefit. NEXUS will not apply it automatically; only an explicit human request can.`,
      );
    }

    if (!descriptor.autoProposable && proposal.origin === 'internal') {
      block('NOT_AUTO_PROPOSABLE', `"${descriptor.name}" is excluded from automatically generated proposals.`);
    }

    /* -------------------------------------------------- telemetry gating */

    if (policy.requiresLiveTelemetry) {
      if (!context.telemetry) {
        block('TELEMETRY_MISSING', `"${descriptor.name}" requires live telemetry, and no telemetry snapshot is available.`);
      } else if (context.telemetry.fidelity !== 'live') {
        block(
          'TELEMETRY_NOT_LIVE',
          `"${descriptor.name}" requires live telemetry; the current snapshot is ${context.telemetry.fidelity}.`,
        );
      }
    }

    if (policy.requiresBaseline && !context.baselineAvailable) {
      block('BASELINE_MISSING', `"${descriptor.name}" requires a captured baseline so the change can be measured and reversed.`);
    }

    /* ---------------------------------------------------- thermal gating */

    if (policy.thermal) {
      findings.push(...this.evaluateThermal(control, descriptor.name, policy.thermal, context));
    }

    /* ------------------------------------------------------ reversibility */

    if (descriptor.reversibility === 'irreversible' || descriptor.reversibility === 'unknown') {
      needsConfirmation = true;
      note(
        'NOT_AUTOMATICALLY_REVERSIBLE',
        `"${descriptor.name}" is ${descriptor.reversibility === 'unknown' ? 'of unknown reversibility' : 'not reversible'}; NEXUS will not apply it without explicit confirmation.`,
      );
    }

    if (descriptor.applyTiming === 'requires-reboot') {
      needsConfirmation = true;
      note(
        'REQUIRES_REBOOT',
        `"${descriptor.name}" only takes effect after a reboot, so NEXUS cannot measure or revert it within this session.`,
      );
    }

    if (descriptor.safetyClass === 'restricted' || policy.requiresConfirmation) {
      needsConfirmation = true;
    }

    /* --------------------------------------------------- confirmation check */

    if (needsConfirmation) {
      const confirmed = confirmationCovers(proposal, control);
      if (confirmed) {
        if (proposal.origin !== 'user') {
          block(
            'CONFIRMATION_ORIGIN_INVALID',
            `A confirmation for "${descriptor.name}" was supplied on a ${proposal.origin}-origin request. Only a request originating with the user can carry a human confirmation.`,
          );
        } else {
          needsConfirmation = false;
          note('CONFIRMED', `Human confirmation supplied for "${descriptor.name}".`);
        }
      }
    }

    /* ------------------------------------------------------------ cooldown */

    const lastApplied = context.recentApplications
      .filter((r) => r.control === control)
      .reduce<number | null>((acc, r) => (acc === null || r.appliedAtMs > acc ? r.appliedAtMs : acc), null);
    if (lastApplied !== null && context.nowMs - lastApplied < policy.cooldownMs) {
      const waitMs = policy.cooldownMs - (context.nowMs - lastApplied);
      block(
        'COOLDOWN',
        `"${descriptor.name}" was changed ${Math.round((context.nowMs - lastApplied) / 1000)}s ago; ${Math.ceil(waitMs / 1000)}s of cooldown remain.`,
      );
    }

    return { findings, needsConfirmation };
  }

  private evaluateThermal(
    control: ControlId,
    controlName: string,
    thermal: NonNullable<SafetyPolicy['controls'][string]['thermal']>,
    context: SafetyContext,
  ): SafetyFinding[] {
    const findings: SafetyFinding[] = [];
    const checks: readonly [keyof typeof thermal, 'cpu.temperature' | 'gpu.temperature' | 'gpu.hotspot', string][] = [
      ['maxCpuTemperatureC', 'cpu.temperature', 'CPU temperature'],
      ['maxGpuTemperatureC', 'gpu.temperature', 'GPU temperature'],
      ['maxGpuHotspotC', 'gpu.hotspot', 'GPU hotspot temperature'],
    ];

    for (const [key, metric, label] of checks) {
      const ceiling = thermal[key];
      if (ceiling === undefined) continue;

      const snapshot = context.telemetry;
      const r = snapshot?.readings.find((x) => x.metric === metric);
      if (!snapshot || !r || !isKnown(r)) {
        findings.push({
          code: 'THERMAL_UNVERIFIABLE',
          severity: 'blocking',
          control,
          message: `"${controlName}" has a ${label} precondition of ${ceiling}°C, but that temperature cannot be read right now. NEXUS fails closed rather than assuming it is safe.`,
        });
        continue;
      }
      if (r.fidelity !== 'live') {
        findings.push({
          code: 'THERMAL_NOT_LIVE',
          severity: 'blocking',
          control,
          message: `"${controlName}" has a ${label} precondition, and the available reading is ${r.fidelity} rather than live.`,
        });
        continue;
      }
      if (r.value > ceiling) {
        findings.push({
          code: 'THERMAL_LIMIT',
          severity: 'blocking',
          control,
          message: `${label} is ${r.value.toFixed(1)}°C, above the ${ceiling}°C precondition for "${controlName}".`,
        });
      }
    }

    return findings;
  }
}

export interface RollbackRequest {
  readonly checkpointId: string;
  readonly origin: RequestOrigin;
  readonly requestedBy: string;
  /** Controls the checkpoint captured, i.e. the maximum scope of the restore. */
  readonly controls: readonly ControlId[];
}

/** Run states in which a human may restore a checkpoint. */
const RUN_STATES_PERMITTING_ROLLBACK: ReadonlySet<RunState> = new Set<RunState>([
  'ready',
  'degraded',
  // Rollback is the corrective action, so it has to remain available exactly
  // when NEXUS has stopped trusting itself. Refusing here would strand the
  // machine in a state NEXUS created and cannot undo.
  'observation_only',
  'recovering',
]);

function confirmationCovers(proposal: OptimizationProposal, control: ControlId): boolean {
  const c = proposal.confirmation;
  if (!c) return false;
  return c.controls.includes(control);
}

/** Convenience for callers that only need to know whether a value is legal. */
export function valueIsWithinPolicy(
  policy: SafetyPolicy,
  control: ControlId,
  value: ControlValue,
): boolean {
  const descriptor = getControl(control);
  if (!descriptor || descriptor.safetyClass === 'prohibited' || descriptor.access !== 'read-write') return false;
  if (!valueMatchesSpec(descriptor.valueSpec, value)) return false;
  const cp = policy.controls[control];
  if (!cp || !cp.allowed) return false;
  if (cp.range && typeof value === 'number' && (value < cp.range.min || value > cp.range.max)) return false;
  return true;
}
