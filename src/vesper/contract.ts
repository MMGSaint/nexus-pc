/**
 * The Vesper integration contract.
 *
 * Vesper is the user's assistant: it understands intent and orchestrates.
 * NEXUS is the hardware specialist: it understands the machine and performs
 * the work. This file is the whole of the boundary between them. The two
 * systems share no code, no process and no repository — only this protocol.
 *
 * Three properties are load-bearing:
 *
 *  1. **Local only.** The transport is a Windows named pipe or a POSIX unix
 *     socket. NEXUS never binds a TCP or UDP port, never listens on the LAN,
 *     and never opens an internet listener.
 *
 *  2. **Fidelity is always reported.** Every response carries the provenance
 *     of the data behind it, so Vesper can tell a real measurement from a
 *     simulation. A mock optimizer cannot return a `live` success.
 *
 *  3. **Asking does not confer authority.** Scopes are granted by the user in
 *     NEXUS's configuration, not claimed in the request. A Vesper request goes
 *     through exactly the same safety kernel as anything else, and a Vesper
 *     request can never carry a human confirmation — only a `user`-origin
 *     request can do that.
 */

import { VESPER_CONTRACT_VERSION } from '../version.js';
import {
  vArray,
  vNumber,
  vObject,
  vOptional,
  vString,
  vUnion,
  vBoolean,
  vEnum,
} from '../core/validate.js';
import { WORKLOAD_CLASSES } from '../domain/workload.js';

export { VESPER_CONTRACT_VERSION };

/**
 * Methods. A scope is required for each; scopes are configured in NEXUS, and
 * the mutating ones are not granted by default.
 */
export const VESPER_METHODS = {
  getStatus: 'status',
  getCapabilities: 'capabilities',
  getTelemetrySummary: 'telemetry',
  getPerformanceEvidence: 'telemetry',
  getCurrentProfile: 'status',
  listProfiles: 'status',
  analyzeWorkload: 'workload',
  declareContext: 'context',
  recommend: 'recommend',
  optimize: 'optimize',
  rollback: 'rollback',
  getOptimizationResult: 'status',
  getDecisionEvidence: 'status',
  getTopology: 'capabilities',
} as const;

export type VesperMethod = keyof typeof VESPER_METHODS;
export type VesperScope = (typeof VESPER_METHODS)[VesperMethod];

/** Scopes granted to a Vesper client unless the user says otherwise. */
export const DEFAULT_SCOPES: readonly VesperScope[] = Object.freeze([
  'status',
  'capabilities',
  'telemetry',
  'workload',
  'recommend',
]);

/** Scopes that let Vesper cause a change. Never granted implicitly. */
export const MUTATING_SCOPES: readonly VesperScope[] = Object.freeze(['optimize', 'rollback', 'context']);

export function methodScope(method: string): VesperScope | null {
  return Object.hasOwn(VESPER_METHODS, method)
    ? VESPER_METHODS[method as VesperMethod]
    : null;
}

/* --------------------------------------------------------------- requests */

export const requestSchema = vObject({
  v: vString({ maxLength: 16 }),
  id: vString({ maxLength: 64 }),
  method: vString({ maxLength: 64 }),
  token: vString({ maxLength: 512 }),
  params: vOptional(
    vObject(
      {
        windowMs: vOptional(vNumber({ integer: true, min: 1_000, max: 86_400_000 })),
        profileId: vOptional(vString({ maxLength: 64 })),
        checkpointId: vOptional(vString({ maxLength: 64 })),
        outcomeId: vOptional(vString({ maxLength: 64 })),
        applicationId: vOptional(vString({ maxLength: 128 })),
        workload: vOptional(vEnum(WORKLOAD_CLASSES)),
        note: vOptional(vString({ maxLength: 512 })),
        ttlMs: vOptional(vNumber({ integer: true, min: 1_000, max: 3_600_000 })),
        dryRun: vOptional(vBoolean()),
        controls: vOptional(
          vArray(
            vObject({
              control: vString({ maxLength: 128 }),
              value: vUnion(vString({ maxLength: 256 }), vNumber(), vBoolean()),
            }),
            { maxItems: 16 },
          ),
        ),
      },
      // Strict: an unknown parameter is an error. There is deliberately no
      // field here by which a caller could assert privilege, and one cannot be
      // smuggled in either.
    ),
  ),
});

export type VesperRequest = {
  readonly v: string;
  readonly id: string;
  readonly method: string;
  readonly token: string;
  readonly params?: VesperParams | undefined;
};

export interface VesperParams {
  readonly windowMs?: number | undefined;
  readonly profileId?: string | undefined;
  readonly checkpointId?: string | undefined;
  readonly outcomeId?: string | undefined;
  readonly applicationId?: string | undefined;
  readonly workload?: (typeof WORKLOAD_CLASSES)[number] | undefined;
  readonly note?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly dryRun?: boolean | undefined;
  readonly controls?: readonly { readonly control: string; readonly value: string | number | boolean }[] | undefined;
}

/* -------------------------------------------------------------- responses */

/**
 * Provenance reported to Vesper.
 *
 *   live        real measurements from this machine
 *   simulated   produced by a model
 *   mocked      produced from fixtures
 *   unverified  NEXUS has not confirmed this is real
 *   unavailable nothing was produced
 */
export type VesperFidelity = 'live' | 'simulated' | 'mocked' | 'unverified' | 'unavailable';

export interface VesperSuccess<T = unknown> {
  readonly v: string;
  readonly id: string;
  readonly ok: true;
  readonly fidelity: VesperFidelity;
  readonly result: T;
}

export interface VesperFailure {
  readonly v: string;
  readonly id: string;
  readonly ok: false;
  readonly fidelity: VesperFidelity;
  readonly error: { readonly code: string; readonly message: string };
}

export type VesperResponse<T = unknown> = VesperSuccess<T> | VesperFailure;

export function success<T>(id: string, fidelity: VesperFidelity, result: T): VesperSuccess<T> {
  return { v: VESPER_CONTRACT_VERSION, id, ok: true, fidelity, result };
}

export function failure(id: string, code: string, message: string, fidelity: VesperFidelity = 'unavailable'): VesperFailure {
  return { v: VESPER_CONTRACT_VERSION, id, ok: false, fidelity, error: { code, message } };
}

/** Major-version compatibility. A different major version is refused. */
export function versionCompatible(clientVersion: string): boolean {
  const clientMajor = clientVersion.split('.')[0];
  const serverMajor = VESPER_CONTRACT_VERSION.split('.')[0];
  return clientMajor !== undefined && clientMajor === serverMajor;
}
