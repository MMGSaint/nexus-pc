/**
 * The safety policy.
 *
 * `BASE_POLICY` is compiled into the binary and frozen. Configuration, Vesper
 * and every other untrusted source can only reach it through `narrowPolicy`,
 * which is constructed so that the effective policy is always a subset of the
 * base:
 *
 *   - a control that is disallowed cannot be re-allowed;
 *   - a numeric range can shrink, never widen;
 *   - an enum can lose options, never gain them;
 *   - a confirmation requirement can be added, never removed;
 *   - thermal ceilings can only come down;
 *   - cooldowns and rate limits can only get stricter;
 *   - observation-only can be switched on, never off.
 *
 * There is no code path that turns the safety layer off. Refusing a request is
 * always representable; disabling the checks is not.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../core/canonical-json.js';
import type { ControlId } from '../domain/control.js';
import { BUILTIN_CONTROLS, getControl } from './controls.js';

export interface ThermalPreconditions {
  readonly maxCpuTemperatureC?: number;
  readonly maxGpuTemperatureC?: number;
  readonly maxGpuHotspotC?: number;
}

export interface ControlPolicy {
  readonly control: ControlId;
  /** May NEXUS write this control at all? */
  readonly allowed: boolean;
  /** Narrower numeric bound than the descriptor's own spec, when applicable. */
  readonly range?: { readonly min: number; readonly max: number };
  /** Permitted subset of the descriptor's enum options, when applicable. */
  readonly allowedValues?: readonly string[];
  /** Requires telemetry with `live` fidelity before it may be applied. */
  readonly requiresLiveTelemetry: boolean;
  /** Requires a captured baseline before it may be applied. */
  readonly requiresBaseline: boolean;
  /** Requires an explicit human confirmation on every application. */
  readonly requiresConfirmation: boolean;
  readonly thermal?: ThermalPreconditions;
  /** Minimum interval between applications of this control. */
  readonly cooldownMs: number;
}

export interface GlobalPolicy {
  /** Hard cap on the number of changes in one proposal. */
  readonly maxChangesPerProposal: number;
  /** Hard cap on applications within a rolling hour. */
  readonly maxAppliedChangesPerHour: number;
  /** Applied state must be read back and match, or the change is rolled back. */
  readonly requireVerification: boolean;
  /** When true, every write is refused. Reporting continues. */
  readonly observationOnly: boolean;
  /** Minimum measurement window before a keep/rollback decision. */
  readonly minMeasurementWindowMs: number;
  /** Ceiling on NEXUS's own CPU use before it throttles its own sampling. */
  readonly selfCpuBudgetPercent: number;
}

export interface SafetyPolicy {
  readonly version: number;
  readonly global: GlobalPolicy;
  readonly controls: Readonly<Record<ControlId, ControlPolicy>>;
}

const DEFAULT_CONTROL_POLICY: Omit<ControlPolicy, 'control'> = {
  allowed: false,
  requiresLiveTelemetry: true,
  requiresBaseline: true,
  requiresConfirmation: false,
  cooldownMs: 60_000,
};

/**
 * Per-control base policy. Anything not listed here inherits
 * `DEFAULT_CONTROL_POLICY`, i.e. it is *not allowed*. Adding a control
 * descriptor is therefore not sufficient to make it writable — the policy has
 * to opt it in explicitly.
 */
const BASE_CONTROL_POLICIES: readonly ControlPolicy[] = [
  {
    control: 'power.scheme.active',
    allowed: true,
    requiresLiveTelemetry: false,
    requiresBaseline: true,
    requiresConfirmation: false,
    cooldownMs: 30_000,
  },
  {
    control: 'power.processor.boost_mode',
    allowed: true,
    range: { min: 0, max: 4 },
    requiresLiveTelemetry: true,
    requiresBaseline: true,
    requiresConfirmation: false,
    thermal: { maxCpuTemperatureC: 85 },
    cooldownMs: 120_000,
  },
  {
    control: 'power.processor.min_state',
    allowed: true,
    // Never below 5%: a zero floor on an idle desktop is not an optimisation.
    range: { min: 5, max: 100 },
    requiresLiveTelemetry: true,
    requiresBaseline: true,
    requiresConfirmation: false,
    thermal: { maxCpuTemperatureC: 85 },
    cooldownMs: 120_000,
  },
  {
    control: 'power.processor.max_state',
    allowed: true,
    // Never below 50%: halving the ceiling is a throttle, not a tune, and a
    // stuck NEXUS must not be able to leave the machine crippled.
    range: { min: 50, max: 100 },
    requiresLiveTelemetry: true,
    requiresBaseline: true,
    requiresConfirmation: false,
    thermal: { maxCpuTemperatureC: 90 },
    cooldownMs: 120_000,
  },
  {
    control: 'power.processor.core_parking_min',
    allowed: true,
    range: { min: 5, max: 100 },
    requiresLiveTelemetry: true,
    requiresBaseline: true,
    requiresConfirmation: false,
    cooldownMs: 120_000,
  },
  {
    control: 'power.pcie.aspm',
    allowed: true,
    range: { min: 0, max: 2 },
    requiresLiveTelemetry: false,
    requiresBaseline: true,
    requiresConfirmation: false,
    cooldownMs: 300_000,
  },
  {
    control: 'process.priority.foreground',
    allowed: true,
    // `high` is reachable only with an explicit human confirmation.
    allowedValues: ['below_normal', 'normal', 'above_normal'],
    requiresLiveTelemetry: true,
    requiresBaseline: false,
    requiresConfirmation: false,
    cooldownMs: 30_000,
  },
  {
    control: 'power.processor.idle_disable',
    allowed: true,
    range: { min: 0, max: 1 },
    requiresLiveTelemetry: true,
    requiresBaseline: true,
    requiresConfirmation: true,
    thermal: { maxCpuTemperatureC: 75 },
    cooldownMs: 600_000,
  },
  {
    control: 'os.game_mode',
    allowed: true,
    requiresLiveTelemetry: false,
    requiresBaseline: false,
    requiresConfirmation: true,
    cooldownMs: 300_000,
  },
  {
    control: 'os.gpu.hardware_scheduling',
    allowed: true,
    requiresLiveTelemetry: false,
    requiresBaseline: true,
    requiresConfirmation: true,
    cooldownMs: 3_600_000,
  },
  {
    control: 'os.mmcss.system_responsiveness',
    allowed: true,
    range: { min: 10, max: 100 },
    requiresLiveTelemetry: false,
    requiresBaseline: true,
    requiresConfirmation: true,
    cooldownMs: 3_600_000,
  },
  {
    control: 'os.mmcss.network_throttling_index',
    allowed: true,
    range: { min: 10, max: 70 },
    requiresLiveTelemetry: false,
    requiresBaseline: true,
    requiresConfirmation: true,
    cooldownMs: 3_600_000,
  },
];

function buildBasePolicy(): SafetyPolicy {
  const controls: Record<ControlId, ControlPolicy> = {};
  // Every known control gets an entry so that "not configured" is explicit.
  for (const descriptor of BUILTIN_CONTROLS) {
    controls[descriptor.id] = Object.freeze({
      ...DEFAULT_CONTROL_POLICY,
      control: descriptor.id,
    });
  }
  for (const policy of BASE_CONTROL_POLICIES) {
    // A policy for a control that is prohibited or read-only is inert: the
    // kernel refuses those before it ever consults the policy.
    controls[policy.control] = Object.freeze({ ...policy });
  }
  return Object.freeze({
    version: 1,
    global: Object.freeze({
      maxChangesPerProposal: 6,
      maxAppliedChangesPerHour: 24,
      requireVerification: true,
      observationOnly: false,
      minMeasurementWindowMs: 20_000,
      selfCpuBudgetPercent: 2,
    }),
    controls: Object.freeze(controls),
  });
}

export const BASE_POLICY: SafetyPolicy = buildBasePolicy();

/* ------------------------------------------------------------- narrowing */

export interface ControlPolicyOverride {
  readonly allowed?: false;
  readonly range?: { readonly min?: number; readonly max?: number };
  readonly allowedValues?: readonly string[];
  readonly requiresLiveTelemetry?: true;
  readonly requiresBaseline?: true;
  readonly requiresConfirmation?: true;
  readonly thermal?: ThermalPreconditions;
  readonly cooldownMs?: number;
}

export interface GlobalPolicyOverride {
  readonly maxChangesPerProposal?: number;
  readonly maxAppliedChangesPerHour?: number;
  readonly requireVerification?: true;
  readonly observationOnly?: true;
  readonly minMeasurementWindowMs?: number;
  readonly selfCpuBudgetPercent?: number;
}

export interface PolicyOverride {
  readonly global?: GlobalPolicyOverride;
  readonly controls?: Readonly<Record<ControlId, ControlPolicyOverride>>;
}

export interface NarrowingRecord {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

export interface NarrowedPolicy {
  readonly policy: SafetyPolicy;
  /** What the override actually changed. Audited on every start. */
  readonly applied: readonly NarrowingRecord[];
  /**
   * Requests that would have widened the policy. They are not applied; they
   * are reported so a mistaken or hostile config is visible rather than silent.
   */
  readonly rejected: readonly NarrowingRecord[];
}

function narrowNumber(
  current: number,
  requested: number | undefined,
  direction: 'lower-is-stricter' | 'higher-is-stricter',
): { value: number; changed: boolean; rejected: boolean } {
  if (requested === undefined || !Number.isFinite(requested)) {
    return { value: current, changed: false, rejected: false };
  }
  const stricter =
    direction === 'lower-is-stricter' ? requested < current : requested > current;
  if (stricter) return { value: requested, changed: true, rejected: false };
  if (requested === current) return { value: current, changed: false, rejected: false };
  return { value: current, changed: false, rejected: true };
}

/**
 * Produce the effective policy. The result is always at least as strict as
 * `base` on every axis.
 */
export function narrowPolicy(base: SafetyPolicy, override: PolicyOverride | undefined): NarrowedPolicy {
  const applied: NarrowingRecord[] = [];
  const rejected: NarrowingRecord[] = [];

  const g = base.global;
  const go = override?.global;

  const maxChanges = narrowNumber(g.maxChangesPerProposal, go?.maxChangesPerProposal, 'lower-is-stricter');
  const maxPerHour = narrowNumber(g.maxAppliedChangesPerHour, go?.maxAppliedChangesPerHour, 'lower-is-stricter');
  const minWindow = narrowNumber(g.minMeasurementWindowMs, go?.minMeasurementWindowMs, 'higher-is-stricter');
  const selfBudget = narrowNumber(g.selfCpuBudgetPercent, go?.selfCpuBudgetPercent, 'lower-is-stricter');

  const record = (
    target: NarrowingRecord[],
    path: string,
    from: unknown,
    to: unknown,
  ): void => {
    target.push({ path, from: String(from), to: String(to) });
  };

  if (maxChanges.changed) record(applied, 'global.maxChangesPerProposal', g.maxChangesPerProposal, maxChanges.value);
  if (maxChanges.rejected) record(rejected, 'global.maxChangesPerProposal', g.maxChangesPerProposal, go?.maxChangesPerProposal);
  if (maxPerHour.changed) record(applied, 'global.maxAppliedChangesPerHour', g.maxAppliedChangesPerHour, maxPerHour.value);
  if (maxPerHour.rejected) record(rejected, 'global.maxAppliedChangesPerHour', g.maxAppliedChangesPerHour, go?.maxAppliedChangesPerHour);
  if (minWindow.changed) record(applied, 'global.minMeasurementWindowMs', g.minMeasurementWindowMs, minWindow.value);
  if (minWindow.rejected) record(rejected, 'global.minMeasurementWindowMs', g.minMeasurementWindowMs, go?.minMeasurementWindowMs);
  if (selfBudget.changed) record(applied, 'global.selfCpuBudgetPercent', g.selfCpuBudgetPercent, selfBudget.value);
  if (selfBudget.rejected) record(rejected, 'global.selfCpuBudgetPercent', g.selfCpuBudgetPercent, go?.selfCpuBudgetPercent);

  // requireVerification and observationOnly are one-way switches. The override
  // types make `false` unrepresentable, and the logic below never lowers them.
  const observationOnly = g.observationOnly || go?.observationOnly === true;
  if (observationOnly !== g.observationOnly) record(applied, 'global.observationOnly', g.observationOnly, observationOnly);
  const requireVerification = g.requireVerification || go?.requireVerification === true;
  if (requireVerification !== g.requireVerification) record(applied, 'global.requireVerification', g.requireVerification, requireVerification);

  const controls: Record<ControlId, ControlPolicy> = {};
  for (const [id, current] of Object.entries(base.controls)) {
    const o = override?.controls?.[id];
    if (!o) {
      controls[id] = current;
      continue;
    }

    const allowed = current.allowed && o.allowed !== false ? true : false;
    if (allowed !== current.allowed) record(applied, `controls.${id}.allowed`, current.allowed, allowed);

    let range = current.range;
    if (o.range) {
      // When the policy has no range of its own, the effective bounds are the
      // control's own value spec. Starting from infinities instead would let a
      // one-sided override produce a non-finite bound, which is both
      // meaningless and unserialisable — `policyDigest` would throw and NEXUS
      // would fail to construct its safety kernel at all.
      const spec = getControl(id)?.valueSpec;
      if (!spec || spec.kind !== 'integer') {
        record(rejected, `controls.${id}.range`, 'control has no numeric range', JSON.stringify(o.range));
      } else {
        const base = current.range ?? { min: spec.min, max: spec.max };
        const min = narrowNumber(base.min, o.range.min, 'higher-is-stricter');
        const max = narrowNumber(base.max, o.range.max, 'lower-is-stricter');
        if (min.rejected) record(rejected, `controls.${id}.range.min`, base.min, o.range.min);
        if (max.rejected) record(rejected, `controls.${id}.range.max`, base.max, o.range.max);
        if (min.changed || max.changed) {
          if (min.value > max.value) {
            // An override that inverts the bounds would permit nothing at all,
            // which is stricter than intended but silently confusing. Refuse it.
            record(rejected, `controls.${id}.range`, JSON.stringify(base), JSON.stringify(o.range));
          } else {
            range = { min: min.value, max: max.value };
            record(applied, `controls.${id}.range`, JSON.stringify(current.range ?? base), JSON.stringify(range));
          }
        }
      }
    }

    let allowedValues = current.allowedValues;
    if (o.allowedValues) {
      const requested = new Set(o.allowedValues);
      // Intersection only: an option not already permitted stays unpermitted.
      const next = current.allowedValues
        ? current.allowedValues.filter((v) => requested.has(v))
        : [...requested];
      const widened = [...requested].filter((v) => current.allowedValues && !current.allowedValues.includes(v));
      if (widened.length > 0) record(rejected, `controls.${id}.allowedValues`, JSON.stringify(current.allowedValues), JSON.stringify(o.allowedValues));
      if (!current.allowedValues || next.length !== current.allowedValues.length) {
        allowedValues = next;
        record(applied, `controls.${id}.allowedValues`, JSON.stringify(current.allowedValues ?? null), JSON.stringify(next));
      }
    }

    const requiresLiveTelemetry = current.requiresLiveTelemetry || o.requiresLiveTelemetry === true;
    const requiresBaseline = current.requiresBaseline || o.requiresBaseline === true;
    const requiresConfirmation = current.requiresConfirmation || o.requiresConfirmation === true;
    for (const [key, before, after] of [
      ['requiresLiveTelemetry', current.requiresLiveTelemetry, requiresLiveTelemetry],
      ['requiresBaseline', current.requiresBaseline, requiresBaseline],
      ['requiresConfirmation', current.requiresConfirmation, requiresConfirmation],
    ] as const) {
      if (before !== after) record(applied, `controls.${id}.${key}`, before, after);
    }

    const cooldown = narrowNumber(current.cooldownMs, o.cooldownMs, 'higher-is-stricter');
    if (cooldown.changed) record(applied, `controls.${id}.cooldownMs`, current.cooldownMs, cooldown.value);
    if (cooldown.rejected) record(rejected, `controls.${id}.cooldownMs`, current.cooldownMs, o.cooldownMs);

    let thermal = current.thermal;
    if (o.thermal) {
      const next: { maxCpuTemperatureC?: number; maxGpuTemperatureC?: number; maxGpuHotspotC?: number } = {
        ...(current.thermal ?? {}),
      };
      for (const key of ['maxCpuTemperatureC', 'maxGpuTemperatureC', 'maxGpuHotspotC'] as const) {
        const requested = o.thermal[key];
        if (requested === undefined) continue;
        const existing = current.thermal?.[key];
        if (existing === undefined || requested < existing) {
          next[key] = requested;
          record(applied, `controls.${id}.thermal.${key}`, existing ?? 'none', requested);
        } else if (requested > existing) {
          record(rejected, `controls.${id}.thermal.${key}`, existing, requested);
        }
      }
      thermal = next;
    }

    const nextPolicy: ControlPolicy = {
      control: id,
      allowed,
      requiresLiveTelemetry,
      requiresBaseline,
      requiresConfirmation,
      cooldownMs: cooldown.value,
      ...(range ? { range } : {}),
      ...(allowedValues ? { allowedValues } : {}),
      ...(thermal ? { thermal } : {}),
    };
    controls[id] = Object.freeze(nextPolicy);
  }

  // An override naming a control that does not exist cannot create one.
  for (const id of Object.keys(override?.controls ?? {})) {
    if (!(id in base.controls)) {
      record(rejected, `controls.${id}`, 'unknown control', 'ignored');
    }
  }

  return {
    policy: Object.freeze({
      version: base.version,
      global: Object.freeze({
        maxChangesPerProposal: maxChanges.value,
        maxAppliedChangesPerHour: maxPerHour.value,
        requireVerification,
        observationOnly,
        minMeasurementWindowMs: minWindow.value,
        selfCpuBudgetPercent: selfBudget.value,
      }),
      controls: Object.freeze(controls),
    }),
    applied,
    rejected,
  };
}

export function policyDigest(policy: SafetyPolicy): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex').slice(0, 32);
}

export function controlPolicy(policy: SafetyPolicy, control: ControlId): ControlPolicy | undefined {
  return policy.controls[control];
}
