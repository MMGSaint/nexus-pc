/**
 * Configuration.
 *
 * Two things are deliberately separated here:
 *
 *   - the *safety policy*, which says what is permissible. Config can only
 *     narrow it (see `safety/policy.ts`); there is no configuration that makes
 *     NEXUS willing to do something the built-in policy forbids.
 *   - the *operating mode*, which says how much NEXUS currently acts. A new
 *     installation starts in `observation`: it measures and reports and
 *     changes nothing. Moving to `assisted` or `autonomous` is a deliberate
 *     act by the person who owns the machine, taken after they have seen
 *     evidence that NEXUS is reading their hardware correctly.
 *
 * The config file is parsed with the same strict schema as everything else, so
 * an unknown field is an error rather than a silently ignored typo.
 */

import path from 'node:path';

import type { NexusError } from '../core/errors.js';
import { pathExists, readJson, writeJson } from '../core/fsx.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import {
  vArray,
  vBoolean,
  vEnum,
  vNumber,
  vObject,
  vOptional,
  vRecord,
  vString,
} from '../core/validate.js';
import { LOG_LEVELS } from '../core/logger.js';
import type { PolicyOverride } from '../safety/policy.js';

export const OPERATING_MODES = [
  /** Measure and report. Never change anything. The default. */
  'observation',
  /** Accept explicit optimization requests; do not act on NEXUS's own initiative. */
  'assisted',
  /** Also act on NEXUS's own proposals, within the safety policy. */
  'autonomous',
] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

/**
 * Policy overrides accept only the narrowing shapes. `allowed` is
 * `vLiteral(false)` and the boolean requirements only accept `true`, so a
 * config asking to widen the policy fails to parse rather than being
 * silently discarded — and the user gets told why.
 */
const policyOverrideSchema = vObject({
  global: vOptional(
    vObject({
      maxChangesPerProposal: vOptional(vNumber({ integer: true, min: 0, max: 64 })),
      maxAppliedChangesPerHour: vOptional(vNumber({ integer: true, min: 0, max: 1000 })),
      requireVerification: vOptional(vEnum(['true'])),
      observationOnly: vOptional(vEnum(['true'])),
      minMeasurementWindowMs: vOptional(vNumber({ integer: true, min: 0, max: 3_600_000 })),
      selfCpuBudgetPercent: vOptional(vNumber({ min: 0, max: 100 })),
    }),
  ),
  controls: vOptional(
    vRecord(
      vObject({
        allowed: vOptional(vEnum(['false'])),
        range: vOptional(vObject({ min: vOptional(vNumber()), max: vOptional(vNumber()) })),
        allowedValues: vOptional(vArray(vString({ maxLength: 64 }), { maxItems: 32 })),
        requiresLiveTelemetry: vOptional(vEnum(['true'])),
        requiresBaseline: vOptional(vEnum(['true'])),
        requiresConfirmation: vOptional(vEnum(['true'])),
        thermal: vOptional(
          vObject({
            maxCpuTemperatureC: vOptional(vNumber({ min: 0, max: 130 })),
            maxGpuTemperatureC: vOptional(vNumber({ min: 0, max: 130 })),
            maxGpuHotspotC: vOptional(vNumber({ min: 0, max: 140 })),
          }),
        ),
        cooldownMs: vOptional(vNumber({ integer: true, min: 0, max: 86_400_000 })),
      }),
      { maxKeys: 64, keyPattern: /^[a-z][a-z0-9._-]{0,63}$/ },
    ),
  ),
});

const configSchema = vObject({
  mode: vOptional(vEnum(OPERATING_MODES)),
  logLevel: vOptional(vEnum(LOG_LEVELS)),
  telemetry: vOptional(
    vObject({
      lowActivityIntervalMs: vOptional(vNumber({ integer: true, min: 1_000, max: 600_000 })),
      activeIntervalMs: vOptional(vNumber({ integer: true, min: 500, max: 120_000 })),
      optimizationIntervalMs: vOptional(vNumber({ integer: true, min: 250, max: 30_000 })),
      historyLimit: vOptional(vNumber({ integer: true, min: 10, max: 10_000 })),
    }),
  ),
  vesper: vOptional(
    vObject({
      enabled: vOptional(vBoolean()),
      /** Scopes granted to an authenticated Vesper client. */
      scopes: vOptional(vArray(vString({ maxLength: 64 }), { maxItems: 32 })),
    }),
  ),
  simulate: vOptional(
    vObject({
      /** Name of a built-in fixture, or a path to one. Development use. */
      hardwareFixture: vOptional(vString({ maxLength: 512 })),
      telemetry: vOptional(vBoolean()),
    }),
  ),
  /** Third-party observation tools are never resolved through PATH. */
  tools: vOptional(
    vObject({
      presentMonPath: vOptional(vString({ maxLength: 1024, pattern: /^[A-Za-z]:[\\/]/ })),
      presentMonSha256: vOptional(vString({ maxLength: 64, pattern: /^[a-fA-F0-9]{64}$/ })),
      coreInfoPath: vOptional(vString({ maxLength: 1024, pattern: /^[A-Za-z]:[\\/]/ })),
      coreInfoSha256: vOptional(vString({ maxLength: 64, pattern: /^[a-fA-F0-9]{64}$/ })),
    }),
  ),
  policy: vOptional(policyOverrideSchema),
});

export interface NexusConfig {
  readonly mode: OperatingMode;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly telemetry: {
    readonly lowActivityIntervalMs: number;
    readonly activeIntervalMs: number;
    readonly optimizationIntervalMs: number;
    readonly historyLimit: number;
  };
  readonly vesper: {
    readonly enabled: boolean;
    readonly scopes: readonly string[];
  };
  readonly simulate: {
    readonly hardwareFixture: string | null;
    readonly telemetry: boolean;
  };
  readonly tools: {
    readonly presentMonPath: string | null;
    readonly presentMonSha256: string | null;
    readonly coreInfoPath: string | null;
    readonly coreInfoSha256: string | null;
  };
  readonly policy: PolicyOverride | undefined;
}

export const DEFAULT_CONFIG: NexusConfig = Object.freeze({
  // A fresh installation observes. Nothing is changed until a human says so.
  mode: 'observation',
  logLevel: 'info',
  telemetry: Object.freeze({
    lowActivityIntervalMs: 30_000,
    activeIntervalMs: 5_000,
    optimizationIntervalMs: 1_000,
    historyLimit: 720,
  }),
  vesper: Object.freeze({
    enabled: false,
    scopes: Object.freeze(['status', 'telemetry', 'capabilities', 'workload', 'recommend']),
  }),
  simulate: Object.freeze({ hardwareFixture: null, telemetry: false }),
  tools: Object.freeze({ presentMonPath: null, presentMonSha256: null, coreInfoPath: null, coreInfoSha256: null }),
  policy: undefined,
});

export function configFile(paths: NexusPaths): string {
  return path.join(paths.home, 'config.json');
}

/**
 * Load configuration. A missing file is not an error — it means defaults. A
 * malformed file *is* an error: NEXUS will not guess what the user meant about
 * settings that govern whether it touches their machine.
 */
export async function loadConfig(paths: NexusPaths): Promise<Result<NexusConfig, NexusError>> {
  const file = configFile(paths);
  if (!(await pathExists(file))) return ok(DEFAULT_CONFIG);

  const parsed = await readJson(file, configSchema);
  if (!parsed.ok) return parsed;
  const raw = parsed.value;

  const telemetry = {
    lowActivityIntervalMs: raw.telemetry?.lowActivityIntervalMs ?? DEFAULT_CONFIG.telemetry.lowActivityIntervalMs,
    activeIntervalMs: raw.telemetry?.activeIntervalMs ?? DEFAULT_CONFIG.telemetry.activeIntervalMs,
    optimizationIntervalMs:
      raw.telemetry?.optimizationIntervalMs ?? DEFAULT_CONFIG.telemetry.optimizationIntervalMs,
    historyLimit: raw.telemetry?.historyLimit ?? DEFAULT_CONFIG.telemetry.historyLimit,
  };

  return ok({
    mode: raw.mode ?? DEFAULT_CONFIG.mode,
    logLevel: raw.logLevel ?? DEFAULT_CONFIG.logLevel,
    telemetry,
    vesper: {
      enabled: raw.vesper?.enabled ?? DEFAULT_CONFIG.vesper.enabled,
      scopes: raw.vesper?.scopes ?? DEFAULT_CONFIG.vesper.scopes,
    },
    simulate: {
      hardwareFixture: raw.simulate?.hardwareFixture ?? null,
      telemetry: raw.simulate?.telemetry ?? false,
    },
    tools: {
      presentMonPath: raw.tools?.presentMonPath ?? null,
      presentMonSha256: raw.tools?.presentMonSha256 ?? null,
      coreInfoPath: raw.tools?.coreInfoPath ?? null,
      coreInfoSha256: raw.tools?.coreInfoSha256 ?? null,
    },
    policy: normalisePolicyOverride(raw.policy),
  });
}

/**
 * The on-disk form of a config.
 *
 * The in-memory `NexusConfig` uses `null` for "not set" so callers do not have
 * to check for two kinds of absence. The file format does not: a written
 * document must satisfy the same schema the loader applies, so absent values
 * are omitted rather than written as null.
 */
export function serializeConfig(config: NexusConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    logLevel: config.logLevel,
    telemetry: { ...config.telemetry },
    vesper: { enabled: config.vesper.enabled, scopes: [...config.vesper.scopes] },
    simulate: {
      ...(config.simulate.hardwareFixture === null
        ? {}
        : { hardwareFixture: config.simulate.hardwareFixture }),
      telemetry: config.simulate.telemetry,
    },
    tools: {
      ...(config.tools.presentMonPath === null ? {} : { presentMonPath: config.tools.presentMonPath }),
      ...(config.tools.presentMonSha256 === null ? {} : { presentMonSha256: config.tools.presentMonSha256 }),
      ...(config.tools.coreInfoPath === null ? {} : { coreInfoPath: config.tools.coreInfoPath }),
      ...(config.tools.coreInfoSha256 === null ? {} : { coreInfoSha256: config.tools.coreInfoSha256 }),
    },
    ...(config.policy === undefined ? {} : { policy: config.policy }),
  };
}

export async function saveConfig(paths: NexusPaths, config: NexusConfig): Promise<Result<true, NexusError>> {
  return writeJson(configFile(paths), serializeConfig(config), { fsyncData: true });
}

/**
 * The schema encodes one-way switches as the string `'true'` / `'false'` so
 * that the *only* representable value is the strict one. This converts that
 * back into the boolean shape `narrowPolicy` expects.
 */
function normalisePolicyOverride(raw: PolicyOverrideRaw | undefined): PolicyOverride | undefined {
  if (!raw) return undefined;

  const global = raw.global
    ? {
        ...(raw.global.maxChangesPerProposal === undefined ? {} : { maxChangesPerProposal: raw.global.maxChangesPerProposal }),
        ...(raw.global.maxAppliedChangesPerHour === undefined ? {} : { maxAppliedChangesPerHour: raw.global.maxAppliedChangesPerHour }),
        ...(raw.global.requireVerification === undefined ? {} : { requireVerification: true as const }),
        ...(raw.global.observationOnly === undefined ? {} : { observationOnly: true as const }),
        ...(raw.global.minMeasurementWindowMs === undefined ? {} : { minMeasurementWindowMs: raw.global.minMeasurementWindowMs }),
        ...(raw.global.selfCpuBudgetPercent === undefined ? {} : { selfCpuBudgetPercent: raw.global.selfCpuBudgetPercent }),
      }
    : undefined;

  const controls: Record<string, Record<string, unknown>> = {};
  for (const [id, override] of Object.entries(raw.controls ?? {})) {
    controls[id] = {
      ...(override.allowed === undefined ? {} : { allowed: false as const }),
      ...(override.range === undefined ? {} : { range: override.range }),
      ...(override.allowedValues === undefined ? {} : { allowedValues: override.allowedValues }),
      ...(override.requiresLiveTelemetry === undefined ? {} : { requiresLiveTelemetry: true as const }),
      ...(override.requiresBaseline === undefined ? {} : { requiresBaseline: true as const }),
      ...(override.requiresConfirmation === undefined ? {} : { requiresConfirmation: true as const }),
      ...(override.thermal === undefined ? {} : { thermal: override.thermal }),
      ...(override.cooldownMs === undefined ? {} : { cooldownMs: override.cooldownMs }),
    };
  }

  return {
    ...(global === undefined ? {} : { global }),
    ...(Object.keys(controls).length === 0 ? {} : { controls }),
  } as PolicyOverride;
}

interface PolicyOverrideRaw {
  global?:
    | {
        maxChangesPerProposal?: number | undefined;
        maxAppliedChangesPerHour?: number | undefined;
        requireVerification?: string | undefined;
        observationOnly?: string | undefined;
        minMeasurementWindowMs?: number | undefined;
        selfCpuBudgetPercent?: number | undefined;
      }
    | undefined;
  controls?:
    | Record<
        string,
        {
          allowed?: string | undefined;
          range?: { min?: number | undefined; max?: number | undefined } | undefined;
          allowedValues?: readonly string[] | undefined;
          requiresLiveTelemetry?: string | undefined;
          requiresBaseline?: string | undefined;
          requiresConfirmation?: string | undefined;
          thermal?:
            | {
                maxCpuTemperatureC?: number | undefined;
                maxGpuTemperatureC?: number | undefined;
                maxGpuHotspotC?: number | undefined;
              }
            | undefined;
          cooldownMs?: number | undefined;
        }
      >
    | undefined;
}
