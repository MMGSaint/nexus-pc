/**
 * Fidelity (provenance) lattice.
 *
 * Every reading, capability, decision and optimization result carries a
 * fidelity. The single most important rule in NEXUS is that a value derived
 * from non-live inputs can never be reported as live: Vesper (and the user)
 * must never receive a fake "success" from a mock.
 *
 * Combination takes the MINIMUM rank, so any mocked input contaminates the
 * whole derivation. There is deliberately no operation that raises fidelity.
 */

export const FIDELITIES = ['unavailable', 'mocked', 'simulated', 'unverified', 'live'] as const;
export type Fidelity = (typeof FIDELITIES)[number];

const RANK: Readonly<Record<Fidelity, number>> = Object.freeze({
  unavailable: 0,
  mocked: 1,
  simulated: 2,
  unverified: 3,
  live: 4,
});

export function fidelityRank(f: Fidelity): number {
  return RANK[f];
}

export function isFidelity(value: unknown): value is Fidelity {
  return typeof value === 'string' && (FIDELITIES as readonly string[]).includes(value);
}

/**
 * Combine provenance of several inputs. The result is never stronger than the
 * weakest input. An empty input set is `unavailable`: nothing was observed.
 */
export function combineFidelity(...inputs: readonly Fidelity[]): Fidelity {
  if (inputs.length === 0) return 'unavailable';
  let weakest: Fidelity = 'live';
  for (const f of inputs) {
    if (RANK[f] < RANK[weakest]) weakest = f;
  }
  return weakest;
}

/** True only for data that came from real hardware on this machine. */
export function isLive(f: Fidelity): boolean {
  return f === 'live';
}

/**
 * True when the fidelity is strong enough to justify changing the machine.
 * Deliberately strict: we do not act on mocked, simulated or absent data.
 */
export function canJustifyHardwareChange(f: Fidelity): boolean {
  return f === 'live';
}
