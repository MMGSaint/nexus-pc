export interface DriverKnownGoodState {
  readonly driverVersion: string;
  readonly capturedAtMs: number;
  readonly gameProfilesHash: string;
  readonly amdStateHash: string | null;
  readonly displayStateHash: string | null;
  readonly vrStateHash: string | null;
  readonly nexusProfileId: string;
}

export interface DriverObservation {
  readonly driverVersion: string | null;
  readonly observedAtMs: number;
  readonly source: 'live' | 'unavailable' | 'mocked';
}

export type DriverReconciliation =
  | { readonly state: 'unchanged'; readonly reason: string }
  | { readonly state: 'changed'; readonly reason: string; readonly recoverable: boolean }
  | { readonly state: 'unknown'; readonly reason: string };

export function reconcileDriver(
  knownGood: DriverKnownGoodState | null,
  observed: DriverObservation,
): DriverReconciliation {
  if (!knownGood) {
    return {
      state: 'unknown',
      reason: 'No known-good driver state has been recorded.',
    };
  }
  if (observed.source !== 'live' || !observed.driverVersion) {
    return {
      state: 'unknown',
      reason: 'Live driver identity is unavailable; no restoration is attempted.',
    };
  }
  if (observed.driverVersion === knownGood.driverVersion) {
    return {
      state: 'unchanged',
      reason: `Driver ${observed.driverVersion} matches the known-good state.`,
    };
  }
  return {
    state: 'changed',
    reason: `Driver changed from ${knownGood.driverVersion} to ${observed.driverVersion}; per-game and display/VR state should be reconciled before claiming configuration is restored.`,
    recoverable: true,
  };
}
