/**
 * Health and lifecycle.
 *
 * "The process exists" is not health. A health report has to answer, at any
 * moment including during startup: what is ready, what is not, what is
 * degraded, whether the last session ended cleanly, and whether recovery is
 * outstanding.
 */

import type { Fidelity } from '../core/fidelity.js';
import type { CapabilityState } from './capability.js';

export const INIT_STAGES = [
  /** Process bootstrapped, config parsed, paths resolved, lock acquired. */
  'core',
  /** Health reporting itself is answerable. Deliberately early. */
  'health',
  /** Audit event log opened and chain verified. */
  'audit',
  /** Previous session inspected; interrupted operations reconciled. */
  'recovery',
  /** Telemetry sources constructed (not yet probed). */
  'telemetry',
  /** Hardware discovery run. */
  'hardware',
  /** Capability probes run. */
  'capabilities',
  /** Profiles loaded and validated against the safety kernel. */
  'profiles',
  /** Baseline captured or loaded. */
  'baseline',
  /** Optimizer permitted to accept requests. */
  'optimizer',
  /** Local IPC endpoint for Vesper listening. */
  'vesper',
] as const;
export type InitStage = (typeof INIT_STAGES)[number];

export const STAGE_STATUSES = ['pending', 'running', 'complete', 'skipped', 'failed'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export interface StageReport {
  readonly stage: InitStage;
  readonly status: StageStatus;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly detail: string | null;
}

export const RUN_STATES = [
  /** Started, still bringing stages up. Not a claim of readiness. */
  'initializing',
  /** All required stages complete; optimization permitted. */
  'ready',
  /** Running, but one or more non-critical stages failed. */
  'degraded',
  /** Running with writes disabled: observation and reporting only. */
  'observation_only',
  /** Reconciling state from an unclean previous session. */
  'recovering',
  'stopping',
  'stopped',
  /** Could not start. */
  'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const SHUTDOWN_KINDS = ['clean', 'crash', 'unknown', 'never_started'] as const;
export type ShutdownKind = (typeof SHUTDOWN_KINDS)[number];

export interface CapabilitySummary {
  readonly total: number;
  readonly byState: Readonly<Record<CapabilityState, number>>;
  readonly available: readonly string[];
  readonly unavailable: readonly string[];
}

export interface HealthReport {
  readonly generatedAtMs: number;
  readonly nexusVersion: string;
  readonly sessionId: string;
  readonly pid: number;
  readonly uptimeMs: number;
  readonly runState: RunState;
  readonly stages: readonly StageReport[];

  readonly hardwareDetected: boolean;
  readonly hardwareFidelity: Fidelity;
  readonly telemetryWorking: boolean;
  readonly telemetryFidelity: Fidelity;
  readonly capabilities: CapabilitySummary;

  readonly activeProfileId: string | null;
  readonly optimizationEnabled: boolean;
  readonly optimizationDisabledReason: string | null;

  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];

  readonly previousShutdown: ShutdownKind;
  readonly recoveryRequired: boolean;
  readonly recoverySummary: string | null;

  readonly vesperInterface: VesperInterfaceHealth;

  readonly selfFootprint: SelfFootprint;
}

export interface VesperInterfaceHealth {
  readonly enabled: boolean;
  readonly listening: boolean;
  readonly endpoint: string | null;
  /** Whether a Vesper client has authenticated in this session. */
  readonly clientSeen: boolean;
  readonly lastRequestAtMs: number | null;
}

export interface SelfFootprint {
  readonly rssBytes: number;
  /** NEXUS's own CPU use as a percentage of one core, averaged over a window. */
  readonly cpuPercent: number | null;
  readonly samplingMode: string;
  readonly telemetryIntervalMs: number;
}
