/**
 * Vesper method handlers.
 *
 * The handlers are a thin, explicit mapping from protocol methods onto a
 * `VesperHost` interface that the runtime implements. Keeping the interface
 * here rather than exposing the runtime directly means the protocol surface is
 * exactly what is written in this file — Vesper cannot reach anything else.
 *
 * Every handler returns a fidelity alongside its result. Where a result is
 * derived from several things, the fidelity is the weakest of them.
 */

import type { Fidelity } from '../core/fidelity.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import type { CapabilityRecord } from '../domain/capability.js';
import type { HealthReport } from '../domain/health.js';
import type { OptimizationOutcome } from '../domain/optimization.js';
import type { ProfileDocument } from '../domain/profile.js';
import type { TelemetrySummary } from '../domain/telemetry.js';
import type { ContextHint, WorkloadClassification } from '../domain/workload.js';
import type { RestoreResult } from '../checkpoint/store.js';
import type { VesperFidelity, VesperParams } from './contract.js';

export interface RecommendationView {
  readonly workload: WorkloadClassification;
  readonly recommendedProfileId: string | null;
  readonly rationale: string;
  /** Changes NEXUS would make. Advisory only; nothing has been applied. */
  readonly proposedChanges: readonly {
    readonly control: string;
    readonly currentValue: string | number | boolean | null;
    readonly targetValue: string | number | boolean;
    readonly rationale: string;
  }[];
  readonly noActionReason: string | null;
}

export interface ProfileView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly targets: readonly string[];
  readonly applicationIds?: readonly string[];
  readonly settings: readonly { readonly control: string; readonly value: string | number | boolean; readonly rationale: string }[];
  readonly applicableHere: boolean;
}

/**
 * What NEXUS exposes to Vesper. Deliberately narrow: this is the whole of the
 * surface, and nothing outside it is reachable over the protocol.
 */
export interface VesperHost {
  getStatus(): Promise<HealthReport>;
  getCapabilities(): Promise<readonly CapabilityRecord[]>;
  getTelemetrySummary(windowMs: number): Promise<TelemetrySummary>;
  getCurrentProfile(): Promise<{ readonly profile: ProfileDocument | null; readonly appliedAtMs: number | null }>;
  listProfiles(): Promise<readonly ProfileView[]>;
  analyzeWorkload(): Promise<WorkloadClassification>;
  /** Record intent Vesper observed. Treated as evidence, never as truth. */
  declareContext(hint: ContextHint): Promise<{ readonly accepted: boolean; readonly note: string }>;
  recommend(profileId?: string): Promise<RecommendationView>;
  optimize(params: { readonly profileId?: string; readonly dryRun?: boolean }): Promise<OptimizationOutcome>;
  rollback(checkpointId: string): Promise<RestoreResult>;
  getOptimizationResult(outcomeId: string): Promise<OptimizationOutcome | null>;
  /** Identifier recorded on Vesper-origin requests, for audit. */
  readonly requesterId: string;
  /** The runtime's clock, so handler timestamps stay deterministic in tests. */
  now(): number;
}

export type VesperHandlerResult =
  | { readonly ok: true; readonly fidelity: VesperFidelity; readonly result: unknown }
  | { readonly ok: false; readonly fidelity: VesperFidelity; readonly error: NexusError };

function okResult(fidelity: Fidelity, result: unknown): VesperHandlerResult {
  return { ok: true, fidelity, result };
}

function errResult(error: NexusError, fidelity: Fidelity = 'unavailable'): VesperHandlerResult {
  return { ok: false, fidelity, error };
}

export async function dispatch(
  host: VesperHost,
  method: string,
  params: VesperParams | undefined,
): Promise<VesperHandlerResult> {
  switch (method) {
    case 'getStatus': {
      const status = await host.getStatus();
      // Status is about NEXUS itself, so it is live whenever NEXUS is running;
      // the hardware fidelity it reports is carried inside the report.
      return okResult('live', status);
    }

    case 'getCapabilities': {
      const capabilities = await host.getCapabilities();
      const anyLive = capabilities.some((c) => c.state === 'available' && c.fidelity === 'live');
      const anyMocked = capabilities.some((c) => c.state === 'mocked');
      return okResult(anyLive ? 'live' : anyMocked ? 'mocked' : 'unavailable', capabilities);
    }

    case 'getTelemetrySummary': {
      const summary = await host.getTelemetrySummary(params?.windowMs ?? 60_000);
      return okResult(summary.fidelity, summary);
    }

    case 'getCurrentProfile': {
      const current = await host.getCurrentProfile();
      return okResult(current.profile === null ? 'unavailable' : 'live', current);
    }

    case 'listProfiles': {
      return okResult('live', await host.listProfiles());
    }

    case 'analyzeWorkload': {
      const classification = await host.analyzeWorkload();
      return okResult(classification.fidelity, classification);
    }

    case 'declareContext': {
      if (!params?.workload) {
        return errResult(nexusError('E_INVALID_INPUT', 'declareContext requires a workload'));
      }
      const hint: ContextHint = {
        workload: params.workload,
        declaredBy: host.requesterId,
        declaredAtMs: host.now(),
        ttlMs: params.ttlMs ?? 600_000,
        ...(params.note === undefined ? {} : { note: params.note }),
      };
      const accepted = await host.declareContext(hint);
      return okResult('live', accepted);
    }

    case 'recommend': {
      const recommendation = await host.recommend(params?.profileId);
      return okResult(recommendation.workload.fidelity, recommendation);
    }

    case 'optimize': {
      const outcome = await host.optimize({
        ...(params?.profileId === undefined ? {} : { profileId: params.profileId }),
        ...(params?.dryRun === undefined ? {} : { dryRun: params.dryRun }),
      });
      // The outcome's own fidelity is authoritative. An outcome produced by a
      // mock actuator arrives here as `mocked` and leaves as `mocked`.
      return okResult(outcome.fidelity, outcome);
    }

    case 'rollback': {
      if (!params?.checkpointId) {
        return errResult(nexusError('E_INVALID_INPUT', 'rollback requires a checkpointId'));
      }
      const restored = await host.rollback(params.checkpointId);
      // The restore's own fidelity is authoritative: a rollback performed by
      // mock adapters is `mocked`, however complete it was. An incomplete
      // restore is `unverified` regardless of what performed it.
      return okResult(restored.complete ? restored.fidelity : 'unverified', restored);
    }

    case 'getOptimizationResult': {
      if (!params?.outcomeId) {
        return errResult(nexusError('E_INVALID_INPUT', 'getOptimizationResult requires an outcomeId'));
      }
      const outcome = await host.getOptimizationResult(params.outcomeId);
      if (!outcome) {
        return errResult(nexusError('E_UNAVAILABLE', `no optimization result with id ${params.outcomeId}`));
      }
      return okResult(outcome.fidelity, outcome);
    }

    default:
      return errResult(nexusError('E_INVALID_INPUT', `unknown method "${method}"`));
  }
}
