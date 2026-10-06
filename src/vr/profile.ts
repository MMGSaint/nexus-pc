import type { GameDesiredSetting, SettingValue } from '../gaming/warden.js';

export type VrPriority =
  | 'frame-pacing'
  | 'latency'
  | 'refresh-target'
  | 'visual-quality'
  | 'thermal-headroom';

export interface VrProfile {
  readonly id: string;
  readonly name: string;
  readonly headsetVendor?: string;
  readonly priorities: readonly VrPriority[];
  readonly targetRefreshHz: number | null;
  readonly settings: readonly GameDesiredSetting[];
  readonly maxGpuUtilizationPct: number;
  readonly minHeadroomPct: number;
  /** Capabilities that must be live before VR policy is evaluated. */
  readonly requiredCapabilities?: readonly string[];
}

export interface VrObservedState {
  readonly active: boolean;
  readonly runtime: string | null;
  readonly headset: string | null;
  readonly refreshHz: number | null;
  readonly compositorFrameTimeMs: number | null;
  readonly appFrameTimeMs: number | null;
  readonly gpuUtilizationPct: number | null;
  readonly gpuTemperatureC: number | null;
  readonly source: 'live' | 'unavailable' | 'mocked';
  readonly capabilities?: Readonly<Record<string, boolean>>;
}

export interface VrDecision {
  readonly profileId: string;
  readonly healthy: boolean;
  readonly supported: boolean;
  readonly reasons: readonly string[];
  readonly proposed: readonly GameDesiredSetting[];
}

/**
 * VR is intentionally judged by consistency and headroom, not raw FPS.
 * A flat-screen profile must never be treated as a VR profile.
 */
export function evaluateVr(
  profile: VrProfile,
  observed: VrObservedState,
): VrDecision {
  const reasons: string[] = [];

  if (!observed.active) {
    reasons.push('VR session is not active.');
    return { profileId: profile.id, healthy: true, supported: true, reasons, proposed: [] };
  }

  const required = profile.requiredCapabilities ?? [];
  const missing = required.filter((id) => observed.capabilities?.[id] !== true);
  if (missing.length > 0) {
    return {
      profileId: profile.id,
      healthy: false,
      supported: false,
      reasons: ['VR policy cannot be evaluated because required capabilities are unavailable: ' + missing.join(', ') + '.'],
      proposed: [],
    };
  }

  if (
    profile.targetRefreshHz !== null &&
    observed.refreshHz !== null &&
    observed.refreshHz < profile.targetRefreshHz
  ) {
    reasons.push(
      `Headset refresh is ${observed.refreshHz} Hz; target is ${profile.targetRefreshHz} Hz.`,
    );
  }

  if (
    observed.compositorFrameTimeMs !== null &&
    profile.targetRefreshHz !== null &&
    observed.compositorFrameTimeMs > 1000 / profile.targetRefreshHz
  ) {
    reasons.push('Compositor frame time exceeds the target refresh budget.');
  }

  if (
    observed.gpuUtilizationPct !== null &&
    observed.gpuUtilizationPct > profile.maxGpuUtilizationPct
  ) {
    reasons.push(
      `GPU utilisation is ${observed.gpuUtilizationPct}% with only limited VR headroom.`,
    );
  }

  if (
    observed.gpuUtilizationPct !== null &&
    observed.gpuUtilizationPct > 100 - profile.minHeadroomPct
  ) {
    reasons.push(
      `GPU headroom is below the configured ${profile.minHeadroomPct}% floor.`,
    );
  }

  return {
    profileId: profile.id,
    healthy: reasons.length === 0,
    supported: true,
    reasons,
    proposed: reasons.length === 0 ? [] : [...profile.settings],
  };
}

export function vrSetting(
  key: string,
  value: SettingValue,
  rationale: string,
  applyTiming: GameDesiredSetting['applyTiming'] = 'relaunch',
): GameDesiredSetting {
  return { key, value, rationale, applyTiming };
}
