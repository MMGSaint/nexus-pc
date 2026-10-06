export type AmdValue = string | number | boolean | null;

export interface AmdSettingObservation {
  readonly key: string;
  readonly value: AmdValue;
  readonly source: 'adlx' | 'adrenalin' | 'unknown';
}

export interface AmdGameState {
  readonly driverVersion: string | null;
  readonly settings: readonly AmdSettingObservation[];
  readonly observedAtMs: number;
  readonly source: 'live' | 'unavailable' | 'mocked';
}

export interface AmdStateAdapter {
  readonly id: string;
  /** Observation-only boundary. This adapter may read AMD state but can never mutate it. */
  readGameState(gameId: string): Promise<AmdGameState>;
}

/** Proposed AMD mutations are data; the SafetyKernel-owned actuator is the only writer. */
export interface AmdSettingProposal {
  readonly key: string;
  readonly value: AmdValue;
}

/**
 * The adapter is deliberately generic. AMD ADLX is an external licensed SDK,
 * so NEXUS talks to a narrow local helper contract instead of copying its source
 * or guessing at private Radeon registry keys.
 */
export function reconcileAmdGameState(
  desired: Readonly<Record<string, AmdValue>>,
  observed: AmdGameState,
): { readonly drift: readonly { key: string; desired: AmdValue; observed: AmdValue | undefined }[]; readonly trustworthy: boolean } {
  const actual = new Map(observed.settings.map((item) => [item.key, item.value] as const));
  const drift = Object.entries(desired)
    .filter(([key, value]) => actual.get(key) !== value)
    .map(([key, value]) => ({ key, desired: value, observed: actual.get(key) }));
  return {
    drift,
    trustworthy: observed.source === 'live' && observed.driverVersion !== null,
  };
}
