/**
 * Audit events.
 *
 * These are the durable record of what NEXUS did and why. They are written to
 * a hash-chained append-only log so that a missing or altered record is
 * detectable, and they are redacted so that a credential can never reach disk
 * through them.
 *
 * High-frequency telemetry is deliberately *not* an event. Telemetry is
 * summarised; only decisions, failures and state transitions are audited.
 */

export const EVENT_KINDS = [
  'session.start',
  'session.end',
  'session.crash_detected',
  'recovery.started',
  'recovery.completed',
  'recovery.failed',
  'hardware.discovered',
  'hardware.discovery_failed',
  'capability.probed',
  'capability.failed',
  'telemetry.source_failed',
  'telemetry.degraded',
  'telemetry.recovered',
  'baseline.captured',
  'baseline.failed',
  'profile.loaded',
  'profile.rejected',
  'profile.activated',
  'profile.deactivated',
  'optimization.requested',
  'optimization.validated',
  'optimization.rejected',
  'optimization.applied',
  'optimization.measured',
  'optimization.kept',
  'optimization.no_action',
  'optimization.failed',
  'stability.observed',
  'power.sandbox.prepared',
  'power.sandbox.kept',
  'power.sandbox.restored',
  'experiment.started',
  'experiment.trial',
  'experiment.completed',
  'checkpoint.created',
  'checkpoint.restored',
  'checkpoint.restore_failed',
  'rollback.performed',
  'rollback.refused',
  'safety.intervention',
  'safety.policy_narrowed',
  'vesper.connected',
  'vesper.rejected',
  'vesper.request',
  'vesper.context_declared',
  'instance.duplicate_refused',
  'state.degraded',
  'state.recovered',
  'maintenance.pruned',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_SEVERITIES = ['info', 'notice', 'warning', 'error', 'critical'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export interface AuditEventInput {
  readonly kind: EventKind;
  readonly severity: EventSeverity;
  readonly message: string;
  readonly data?: Record<string, unknown>;
  /** Groups the events belonging to one optimization or recovery operation. */
  readonly correlationId?: string;
}

export interface AuditEvent extends AuditEventInput {
  /** Monotonically increasing within a log, starting at 1. */
  readonly seq: number;
  readonly timestampMs: number;
  readonly sessionId: string;
  /** Hash of the previous record; the genesis record uses GENESIS_HASH. */
  readonly prevHash: string;
  /** sha256 over the canonical form of this record excluding `hash`. */
  readonly hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export const DEFAULT_SEVERITY: Readonly<Partial<Record<EventKind, EventSeverity>>> = Object.freeze({
  'session.crash_detected': 'warning',
  'recovery.failed': 'error',
  'hardware.discovery_failed': 'warning',
  'capability.failed': 'notice',
  'telemetry.degraded': 'warning',
  'optimization.failed': 'error',
  'checkpoint.restore_failed': 'critical',
  'rollback.refused': 'error',
  'safety.intervention': 'warning',
  'vesper.rejected': 'warning',
  'instance.duplicate_refused': 'notice',
  'state.degraded': 'warning',
});
