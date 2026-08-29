/**
 * Profiles.
 *
 * A profile is a *complete, explicit* list of the controls it changes. There
 * is no "and some tuning" clause: if a setting is not in `settings`, applying
 * the profile does not change it. That is what makes "NEXUS never silently
 * makes undocumented changes" checkable rather than aspirational.
 */

import type { ControlId, ControlValue } from './control.js';
import type { CapabilityId } from './capability.js';
import type { WorkloadClass } from './workload.js';

export interface ProfileSetting {
  readonly control: ControlId;
  readonly value: ControlValue;
  /** Why this profile sets this control. Shown to the user verbatim. */
  readonly rationale: string;
}

export const PROFILE_AUTHORS = ['builtin', 'user'] as const;
export type ProfileAuthor = (typeof PROFILE_AUTHORS)[number];

export interface ProfileDocument {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly author: ProfileAuthor;
  /** Workloads this profile is intended for. Advisory, not enforcement. */
  readonly targets: readonly WorkloadClass[];
  readonly settings: readonly ProfileSetting[];
  /** Capabilities that must be available for the profile to apply fully. */
  readonly requiresCapabilities: readonly CapabilityId[];
}

export const OBSERVATION_PROFILE_ID = 'observation';

export interface ProfileApplicability {
  readonly profileId: string;
  readonly applicable: boolean;
  /** Settings that can be applied on this machine right now. */
  readonly supported: readonly ProfileSetting[];
  /** Settings that cannot, with the reason. */
  readonly unsupported: readonly { readonly setting: ProfileSetting; readonly reason: string }[];
  readonly blockingReasons: readonly string[];
}

export interface ActiveProfileState {
  readonly profileId: string;
  readonly appliedAtMs: number;
  /** Checkpoint that can restore the pre-profile state, when one exists. */
  readonly checkpointId: string | null;
  /** Which settings actually took effect. */
  readonly appliedSettings: readonly ProfileSetting[];
  readonly partial: boolean;
}
