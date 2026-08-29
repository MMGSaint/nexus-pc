/**
 * Windows power-plan control adapters.
 *
 * These drive `powercfg.exe`, which is present on every Windows install and
 * needs nothing extra. Each adapter reads the current value before it writes,
 * and the engine will not proceed without that read succeeding — that is what
 * makes every one of these changes reversible.
 *
 * NEXUS modifies the *active* power scheme and checkpoints the exact prior
 * index of every setting it touches. See docs/limitations.md for the tradeoff
 * against the alternative design (duplicating the user's scheme and editing
 * only the copy), which is safer still and is the planned next step.
 *
 * STATUS: implemented, hardware dependent. The subgroup and setting GUIDs
 * below are the documented Windows identifiers, but they have not been
 * executed against a Windows host from this repository. Every adapter probes
 * itself first, and a GUID that does not resolve makes the control
 * `unavailable` rather than producing a wrong write.
 */

import type { CommandRunner } from '../../core/exec.js';
import type { NexusError } from '../../core/errors.js';
import { nexusError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import type { ControlId, ControlValue } from '../../domain/control.js';
import type { ActuatorContext, ControlAdapter } from '../actuator.js';

/** Documented Windows power-setting identifiers. */
export const POWER_GUIDS = Object.freeze({
  SUB_PROCESSOR: '54533251-82be-4824-96c1-47b60b740d00',
  PERFBOOSTMODE: 'be337238-0d82-4146-a960-4f3749d470c7',
  PROCTHROTTLEMIN: '893dee8e-2bef-41e0-89c6-b55d0929964c',
  PROCTHROTTLEMAX: 'bc5038f7-23e0-4960-96da-33abaf5935ec',
  CPMINCORES: '0cc5b647-c1df-4637-891a-dec35c318583',
  IDLEDISABLE: '5d76a2ca-e8c0-402f-a133-2158492d58ad',
  SUB_PCIEXPRESS: '501a4d13-42af-4429-9fd1-a8218c268e20',
  ASPM: 'ee12f906-d277-404b-b6da-e5fa1a576df5',
});

const GUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ACTIVE_SCHEME = /Power Scheme GUID:\s*([0-9a-fA-F-]{36})/;
const AC_INDEX = /Current AC Power Setting Index:\s*(0x[0-9a-fA-F]+|\d+)/;

export async function activeSchemeGuid(
  runner: CommandRunner,
  timeoutMs: number,
): Promise<Result<string, NexusError>> {
  const result = await runner.run({ file: 'powercfg.exe', args: ['/getactivescheme'], timeoutMs });
  if (!result.ok) return err(result.error);
  const match = ACTIVE_SCHEME.exec(result.value.stdout);
  if (!match?.[1]) {
    return err(nexusError('E_UNAVAILABLE', 'powercfg did not report an active power scheme'));
  }
  return ok(match[1].toLowerCase());
}

/**
 * The active Windows power scheme, addressed by GUID.
 *
 * The value is opaque: NEXUS never synthesises a scheme GUID, it only ever
 * writes back one it previously read, or one the user named explicitly.
 */
export class WindowsPowerSchemeAdapter implements ControlAdapter {
  readonly id = 'windows.powercfg.scheme';
  readonly control: ControlId = 'power.scheme.active';
  readonly trust = 'live' as const;

  async probe(context: ActuatorContext): Promise<Result<true, NexusError>> {
    const active = await activeSchemeGuid(context.runner, context.timeoutMs);
    return active.ok ? ok(true) : err(active.error);
  }

  async read(context: ActuatorContext): Promise<Result<ControlValue | null, NexusError>> {
    const active = await activeSchemeGuid(context.runner, context.timeoutMs);
    return active.ok ? ok(active.value) : err(active.error);
  }

  async write(context: ActuatorContext, value: ControlValue): Promise<Result<true, NexusError>> {
    if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
      return err(nexusError('E_INVALID_INPUT', 'a power scheme must be identified by a GUID'));
    }
    const result = await context.runner.run({
      file: 'powercfg.exe',
      args: ['/setactive', value],
      timeoutMs: context.timeoutMs,
    });
    if (!result.ok) return err(result.error);
    if (result.value.code !== 0) {
      return err(
        nexusError('E_IO', `powercfg /setactive failed: ${result.value.stderr.trim() || `exit ${result.value.code}`}`),
      );
    }
    return ok(true);
  }
}

export interface PowerSettingAdapterOptions {
  readonly control: ControlId;
  readonly subgroupGuid: string;
  readonly settingGuid: string;
  /** Human-readable name used in error messages. */
  readonly name: string;
}

/**
 * A single integer power setting on the active scheme.
 *
 * Reads parse `Current AC Power Setting Index` from `powercfg /query`. Writes
 * use `/setacvalueindex` and then re-activate the scheme, which is what makes
 * the change take effect.
 */
export class WindowsPowerSettingAdapter implements ControlAdapter {
  readonly id: string;
  readonly control: ControlId;
  readonly trust = 'live' as const;
  private readonly options: PowerSettingAdapterOptions;

  constructor(options: PowerSettingAdapterOptions) {
    this.options = options;
    this.control = options.control;
    this.id = `windows.powercfg.${options.control}`;
  }

  async probe(context: ActuatorContext): Promise<Result<true, NexusError>> {
    const value = await this.read(context);
    if (!value.ok) return err(value.error);
    if (value.value === null) {
      return err(
        nexusError('E_UNAVAILABLE', `${this.options.name} is not exposed by this machine's power scheme`),
      );
    }
    return ok(true);
  }

  async read(context: ActuatorContext): Promise<Result<ControlValue | null, NexusError>> {
    const scheme = await activeSchemeGuid(context.runner, context.timeoutMs);
    if (!scheme.ok) return err(scheme.error);

    const result = await context.runner.run({
      file: 'powercfg.exe',
      args: ['/query', scheme.value, this.options.subgroupGuid, this.options.settingGuid],
      timeoutMs: context.timeoutMs,
    });
    if (!result.ok) return err(result.error);
    if (result.value.code !== 0) {
      return err(
        nexusError(
          'E_UNAVAILABLE',
          `powercfg could not query ${this.options.name}: ${result.value.stderr.trim() || `exit ${result.value.code}`}`,
        ),
      );
    }
    return ok(parseAcIndex(result.value.stdout));
  }

  async write(context: ActuatorContext, value: ControlValue): Promise<Result<true, NexusError>> {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffff) {
      return err(nexusError('E_INVALID_INPUT', `${this.options.name} takes a small non-negative integer`));
    }
    const scheme = await activeSchemeGuid(context.runner, context.timeoutMs);
    if (!scheme.ok) return err(scheme.error);

    const set = await context.runner.run({
      file: 'powercfg.exe',
      args: [
        '/setacvalueindex',
        scheme.value,
        this.options.subgroupGuid,
        this.options.settingGuid,
        String(value),
      ],
      timeoutMs: context.timeoutMs,
    });
    if (!set.ok) return err(set.error);
    if (set.value.code !== 0) {
      const stderr = set.value.stderr.trim();
      return err(
        nexusError(
          'E_IO',
          `powercfg could not set ${this.options.name}: ${stderr || `exit ${set.value.code}`}${
            /denied|elevat|administrator/i.test(stderr) ? ' (this setting requires an elevated process)' : ''
          }`,
        ),
      );
    }

    // The scheme has to be re-activated for a changed index to take effect.
    const activate = await context.runner.run({
      file: 'powercfg.exe',
      args: ['/setactive', scheme.value],
      timeoutMs: context.timeoutMs,
    });
    if (!activate.ok) return err(activate.error);
    if (activate.value.code !== 0) {
      return err(nexusError('E_IO', `powercfg could not re-activate the scheme after setting ${this.options.name}`));
    }
    return ok(true);
  }
}

export function parseAcIndex(stdout: string): number | null {
  const match = AC_INDEX.exec(stdout);
  if (!match?.[1]) return null;
  const raw = match[1];
  const value = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/** The Windows power controls NEXUS knows how to drive. */
export function windowsPowerAdapters(): ControlAdapter[] {
  return [
    new WindowsPowerSchemeAdapter(),
    new WindowsPowerSettingAdapter({
      control: 'power.processor.boost_mode',
      subgroupGuid: POWER_GUIDS.SUB_PROCESSOR,
      settingGuid: POWER_GUIDS.PERFBOOSTMODE,
      name: 'processor performance boost mode',
    }),
    new WindowsPowerSettingAdapter({
      control: 'power.processor.min_state',
      subgroupGuid: POWER_GUIDS.SUB_PROCESSOR,
      settingGuid: POWER_GUIDS.PROCTHROTTLEMIN,
      name: 'minimum processor state',
    }),
    new WindowsPowerSettingAdapter({
      control: 'power.processor.max_state',
      subgroupGuid: POWER_GUIDS.SUB_PROCESSOR,
      settingGuid: POWER_GUIDS.PROCTHROTTLEMAX,
      name: 'maximum processor state',
    }),
    new WindowsPowerSettingAdapter({
      control: 'power.processor.core_parking_min',
      subgroupGuid: POWER_GUIDS.SUB_PROCESSOR,
      settingGuid: POWER_GUIDS.CPMINCORES,
      name: 'processor core parking minimum cores',
    }),
    new WindowsPowerSettingAdapter({
      control: 'power.processor.idle_disable',
      subgroupGuid: POWER_GUIDS.SUB_PROCESSOR,
      settingGuid: POWER_GUIDS.IDLEDISABLE,
      name: 'processor idle state disable',
    }),
    new WindowsPowerSettingAdapter({
      control: 'power.pcie.aspm',
      subgroupGuid: POWER_GUIDS.SUB_PCIEXPRESS,
      settingGuid: POWER_GUIDS.ASPM,
      name: 'PCI Express link state power management',
    }),
  ];
}
