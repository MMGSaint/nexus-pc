/**
 * Profile loading and validation.
 *
 * A profile is validated against the control registry and the safety kernel's
 * policy at load time, not at apply time. A profile that names a control that
 * does not exist, or sets a value the policy would refuse, is rejected with a
 * reason — it never sits in the list waiting to fail later.
 *
 * User profiles are parsed with the same strict schema as everything else, so
 * a profile file cannot smuggle extra fields.
 */

import path from 'node:path';

import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import { listFiles, readJson } from '../core/fsx.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import {
  vArray,
  vBoolean,
  vEnum,
  vNumber,
  vObject,
  vOptional,
  vString,
  vUnion,
} from '../core/validate.js';
import { formatIssues } from '../core/validate.js';
import type { CapabilityId, CapabilityRecord } from '../domain/capability.js';
import { WORKLOAD_CLASSES } from '../domain/workload.js';
import type { ProfileApplicability, ProfileDocument, ProfileSetting } from '../domain/profile.js';
import { getControl } from '../safety/controls.js';
import { describeValueSpec, valueMatchesSpec } from '../domain/control.js';
import type { SafetyPolicy } from '../safety/policy.js';
import { BUILTIN_PROFILES } from './builtin.js';

const profileSchema = vObject({
  id: vString({ maxLength: 64, pattern: /^[a-z0-9][a-z0-9_-]{0,63}$/ }),
  name: vString({ maxLength: 128 }),
  description: vString({ maxLength: 1024 }),
  version: vNumber({ integer: true, min: 1, max: 1_000_000 }),
  author: vEnum(['builtin', 'user']),
  targets: vArray(vEnum(WORKLOAD_CLASSES), { maxItems: 16 }),
  applicationIds: vOptional(vArray(vString({ maxLength: 64, pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }), { maxItems: 16 })),
  settings: vArray(
    vObject({
      control: vString({ maxLength: 128 }),
      value: vUnion(vString({ maxLength: 256 }), vNumber(), vBoolean()),
      rationale: vString({ maxLength: 512 }),
    }),
    { maxItems: 32 },
  ),
  requiresCapabilities: vArray(vString({ maxLength: 128 }), { maxItems: 32 }),
});

export interface ProfileValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Static validation: the profile is coherent with the control registry and
 * would not be refused outright by policy. Machine-specific checks (is the
 * capability actually available here?) happen in `applicability`.
 */
export function validateProfile(profile: ProfileDocument, policy: SafetyPolicy): ProfileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const setting of profile.settings) {
    if (seen.has(setting.control)) {
      errors.push(`control "${setting.control}" is set more than once`);
    }
    seen.add(setting.control);

    const descriptor = getControl(setting.control);
    if (!descriptor) {
      errors.push(`control "${setting.control}" does not exist`);
      continue;
    }
    if (descriptor.safetyClass === 'prohibited') {
      errors.push(`control "${setting.control}" is prohibited and can never be part of a profile`);
      continue;
    }
    if (descriptor.access !== 'read-write') {
      errors.push(`control "${setting.control}" is read-only`);
      continue;
    }
    if (!valueMatchesSpec(descriptor.valueSpec, setting.value)) {
      errors.push(
        `value ${JSON.stringify(setting.value)} is not valid for "${setting.control}" (expected ${describeValueSpec(descriptor.valueSpec)})`,
      );
      continue;
    }

    const controlPolicy = policy.controls[setting.control];
    if (!controlPolicy || !controlPolicy.allowed) {
      errors.push(`policy does not permit writes to "${setting.control}"`);
      continue;
    }
    if (controlPolicy.range && typeof setting.value === 'number') {
      if (setting.value < controlPolicy.range.min || setting.value > controlPolicy.range.max) {
        errors.push(
          `value ${setting.value} for "${setting.control}" is outside the policy range ${controlPolicy.range.min}..${controlPolicy.range.max}`,
        );
        continue;
      }
    }
    if (descriptor.evidenceLevel === 'contested') {
      warnings.push(
        `"${setting.control}" has contested evidence of benefit; applying this profile will require explicit confirmation`,
      );
    }
    if (descriptor.applyTiming === 'requires-reboot') {
      warnings.push(`"${setting.control}" only takes effect after a reboot`);
    }
  }

  if (profile.settings.length === 0 && profile.id !== 'observation') {
    warnings.push('this profile changes nothing');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** What this profile can actually do on *this* machine, right now. */
export function applicability(
  profile: ProfileDocument,
  capabilities: ReadonlyMap<CapabilityId, CapabilityRecord>,
): ProfileApplicability {
  const supported: ProfileSetting[] = [];
  const unsupported: { setting: ProfileSetting; reason: string }[] = [];
  const blocking: string[] = [];

  for (const capabilityId of profile.requiresCapabilities) {
    const record = capabilities.get(capabilityId);
    if (!record) blocking.push(`capability "${capabilityId}" has not been probed`);
    else if (record.state !== 'available' && record.state !== 'mocked') {
      blocking.push(`capability "${capabilityId}" is ${record.state}: ${record.detail}`);
    }
  }

  for (const setting of profile.settings) {
    const descriptor = getControl(setting.control);
    if (!descriptor) {
      unsupported.push({ setting, reason: 'control does not exist' });
      continue;
    }
    const missing = descriptor.requiresCapabilities.filter((id) => {
      const record = capabilities.get(id);
      return !record || (record.state !== 'available' && record.state !== 'mocked');
    });
    if (missing.length > 0) {
      unsupported.push({ setting, reason: `requires unavailable capabilities: ${missing.join(', ')}` });
      continue;
    }
    supported.push(setting);
  }

  return {
    profileId: profile.id,
    applicable: blocking.length === 0 && supported.length > 0,
    supported,
    unsupported,
    blockingReasons: blocking,
  };
}

export interface LoadedProfile {
  readonly profile: ProfileDocument;
  readonly validation: ProfileValidation;
  readonly source: 'builtin' | string;
}

export class ProfileStore {
  private readonly paths: NexusPaths;
  private readonly logger: Logger;
  private readonly policy: SafetyPolicy;
  private profiles = new Map<string, LoadedProfile>();

  constructor(paths: NexusPaths, logger: Logger, policy: SafetyPolicy) {
    this.paths = paths;
    this.logger = logger.child('profiles');
    this.policy = policy;
  }

  /**
   * Load built-in profiles, then user profiles from disk. A user profile with
   * the id of a built-in one replaces it; a built-in profile that fails
   * validation is a bug and is reported loudly rather than hidden.
   */
  async load(): Promise<{ loaded: readonly LoadedProfile[]; rejected: readonly { id: string; errors: readonly string[] }[] }> {
    const loaded = new Map<string, LoadedProfile>();
    const rejected: { id: string; errors: readonly string[] }[] = [];

    for (const profile of BUILTIN_PROFILES) {
      const validation = validateProfile(profile, this.policy);
      if (!validation.valid) {
        rejected.push({ id: profile.id, errors: validation.errors });
        this.logger.error('a built-in profile failed validation', { profile: profile.id, errors: validation.errors });
        continue;
      }
      loaded.set(profile.id, { profile, validation, source: 'builtin' });
    }

    for (const file of await listFiles(this.paths.profiles)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(this.paths.profiles, file);
      const parsed = await readJson(full, profileSchema);
      if (!parsed.ok) {
        rejected.push({ id: file, errors: [parsed.error.message] });
        this.logger.warn('profile file rejected', { file, error: parsed.error.message });
        continue;
      }
      const profile = parsed.value as ProfileDocument;
      const validation = validateProfile(profile, this.policy);
      if (!validation.valid) {
        rejected.push({ id: profile.id, errors: validation.errors });
        this.logger.warn('profile failed validation', { profile: profile.id, errors: validation.errors });
        continue;
      }
      loaded.set(profile.id, { profile, validation, source: full });
    }

    this.profiles = loaded;
    return { loaded: [...loaded.values()], rejected };
  }

  get(id: string): LoadedProfile | undefined {
    return this.profiles.get(id);
  }

  list(): readonly LoadedProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.profile.id.localeCompare(b.profile.id));
  }

  /** Best profile for a workload, or undefined when none targets it. */
  suggestFor(workload: string, detectedApplicationIds: readonly string[] = []): LoadedProfile | undefined {
    const candidates = this.list().filter(
      (p) => p.profile.id !== 'observation' && p.profile.targets.includes(workload as never),
    );
    if (detectedApplicationIds.length > 0) {
      const appSpecific = candidates.find((p) =>
        (p.profile.applicationIds ?? []).some((id) => detectedApplicationIds.includes(id)),
      );
      if (appSpecific) return appSpecific;
    }
    return candidates[0];
  }

  async parseFile(file: string): Promise<Result<ProfileDocument, NexusError>> {
    const parsed = await readJson(file, profileSchema);
    if (!parsed.ok) return err(parsed.error);
    const profile = parsed.value as ProfileDocument;
    const validation = validateProfile(profile, this.policy);
    if (!validation.valid) {
      return err(
        nexusError('E_INVALID_INPUT', `profile "${profile.id}" is not valid`, {
          errors: validation.errors,
        }),
      );
    }
    return ok(profile);
  }
}

export function describeIssuesShort(issues: Parameters<typeof formatIssues>[0]): string {
  return formatIssues(issues, 4);
}
