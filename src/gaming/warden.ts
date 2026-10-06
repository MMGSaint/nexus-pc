import type { WorkloadClass } from '../domain/workload.js';

export type SettingValue = string | number | boolean | null;

export interface GameDesiredSetting {
  readonly key: string;
  readonly value: SettingValue;
  readonly rationale: string;
  readonly applyTiming: 'live' | 'relaunch' | 'reboot';
}

export interface GameProfile {
  readonly id: string;
  readonly name: string;
  readonly executableNames: readonly string[];
  readonly workloads: readonly WorkloadClass[];
  readonly settings: readonly GameDesiredSetting[];
  readonly vr?: boolean;
  readonly version: number;
}

export interface ObservedGameState {
  readonly executableName: string;
  readonly settings: Readonly<Record<string, SettingValue>>;
  readonly driverVersion: string | null;
  readonly gameVersion: string | null;
  readonly observedAtMs: number;
  readonly source: 'live' | 'unavailable' | 'mocked';
}

export interface DriftItem {
  readonly key: string;
  readonly desired: SettingValue;
  readonly observed: SettingValue | undefined;
  readonly applyTiming: GameDesiredSetting['applyTiming'];
  readonly reason: string;
}

export type ReconciliationState =
  | 'in-sync'
  | 'drift'
  | 'pending-relaunch'
  | 'pending-reboot'
  | 'unsupported';

export interface WardenReconciliation {
  readonly profileId: string;
  readonly state: ReconciliationState;
  readonly drift: readonly DriftItem[];
  readonly pendingRestart: boolean;
  readonly summary: string;
}

/** Compare explicit desired state with observed state. Unknown is never treated as equal. */
export function reconcileGameProfile(
  profile: GameProfile,
  observed: ObservedGameState,
): WardenReconciliation {
  const drift: DriftItem[] = [];

  for (const desired of profile.settings) {
    const actual = observed.settings[desired.key];
    if (actual === desired.value) continue;
    drift.push({
      key: desired.key,
      desired: desired.value,
      observed: actual,
      applyTiming: desired.applyTiming,
      reason: desired.rationale,
    });
  }

  if (!drift.length) {
    return {
      profileId: profile.id,
      state: 'in-sync',
      drift: [],
      pendingRestart: false,
      summary: `Profile '${profile.name}' matches observed state.`,
    };
  }

  const hasReboot = drift.some((item) => item.applyTiming === 'reboot');
  const hasRelaunch = drift.some((item) => item.applyTiming === 'relaunch');

  const state: ReconciliationState =
    hasReboot ? 'pending-reboot' : hasRelaunch ? 'pending-relaunch' : 'drift';

  return {
    profileId: profile.id,
    state,
    drift,
    pendingRestart: hasReboot || hasRelaunch,
    summary: describeReconciliation(profile, state, drift),
  };
}

function describeReconciliation(
  profile: GameProfile,
  state: ReconciliationState,
  drift: readonly DriftItem[],
): string {
  const names = drift.map((item) => item.key).join(', ');
  if (state === 'pending-reboot') {
    return `'${profile.name}' has configuration drift in ${names}; some changes take effect after reboot/login.`;
  }
  if (state === 'pending-relaunch') {
    return `'${profile.name}' has configuration drift in ${names}; some changes take effect when the game is relaunched.`;
  }
  return `'${profile.name}' has live configuration drift in ${names}.`;
}

export function selectGameProfile(
  profiles: readonly GameProfile[],
  executableName: string,
  workload?: WorkloadClass,
): GameProfile | undefined {
  const normalized = executableName.trim().toLowerCase();
  const candidates = profiles.filter((profile) =>
    profile.executableNames.some((name) => name.trim().toLowerCase() === normalized),
  );
  if (workload) {
    return candidates.find((profile) => profile.workloads.includes(workload)) ?? candidates[0];
  }
  return candidates[0];
}

/** Desired state is explicit; it never turns an unavailable observation into permission to write. */
export function stageRestartChanges(
  reconciliation: WardenReconciliation,
): readonly DriftItem[] {
  return reconciliation.drift.filter((item) => item.applyTiming === 'reboot' || item.applyTiming === 'relaunch');
}
