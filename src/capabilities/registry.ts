/**
 * The capability registry.
 *
 * A capability becomes `available` only by being probed successfully on this
 * machine. Registering a probe does not make the capability exist; that
 * distinction is the whole point of this module.
 *
 * The registry also clamps fidelity. Each probe is registered with the trust
 * level of the provider behind it, and the recorded fidelity is the weaker of
 * (provider trust, probe's own claim). A mock provider that claims `live`
 * therefore still records `mocked` — a mock cannot impersonate real hardware
 * control no matter what it returns.
 */

import type { Clock } from '../core/clock.js';
import type { Fidelity } from '../core/fidelity.js';
import { combineFidelity } from '../core/fidelity.js';
import type { Logger } from '../core/logger.js';
import type {
  CapabilityDescriptor,
  CapabilityId,
  CapabilityRecord,
  CapabilityState,
} from '../domain/capability.js';

export interface ProbeOutcome {
  readonly state: CapabilityState;
  readonly detail: string;
  readonly fidelity?: Fidelity;
  readonly backendVersion?: string;
}

export interface ProbeContext {
  readonly nowMs: number;
  readonly logger: Logger;
  readonly timeoutMs: number;
}

export interface CapabilityProbe {
  readonly descriptor: CapabilityDescriptor;
  /**
   * Trust level of the provider. `live` for a provider that talks to real
   * hardware, `mocked` for fixtures, `simulated` for a model.
   */
  readonly trust: Fidelity;
  probe(context: ProbeContext): Promise<ProbeOutcome>;
}

const UNPROBED_DETAIL = 'not probed yet';

export class CapabilityRegistry {
  private readonly probes = new Map<CapabilityId, CapabilityProbe>();
  private readonly records = new Map<CapabilityId, CapabilityRecord>();
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(clock: Clock, logger: Logger) {
    this.clock = clock;
    this.logger = logger.child('capabilities');
  }

  /**
   * Register a probe. The capability immediately exists in the registry as
   * `unverified` — visible, described, and explicitly not usable.
   */
  register(probe: CapabilityProbe): void {
    const { descriptor } = probe;
    if (this.probes.has(descriptor.id)) {
      throw new Error(`capability already registered: ${descriptor.id}`);
    }
    this.probes.set(descriptor.id, probe);
    this.records.set(descriptor.id, {
      ...descriptor,
      state: 'unverified',
      fidelity: 'unverified',
      detail: UNPROBED_DETAIL,
      probedAtMs: null,
    });
  }

  registerAll(probes: readonly CapabilityProbe[]): void {
    for (const probe of probes) this.register(probe);
  }

  has(id: CapabilityId): boolean {
    return this.records.has(id);
  }

  get(id: CapabilityId): CapabilityRecord | undefined {
    return this.records.get(id);
  }

  /** Immutable snapshot suitable for handing to the safety kernel. */
  snapshot(): ReadonlyMap<CapabilityId, CapabilityRecord> {
    return new Map(this.records);
  }

  list(): readonly CapabilityRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  descriptors(): readonly CapabilityDescriptor[] {
    return [...this.probes.values()].map((p) => p.descriptor);
  }

  /**
   * Probe everything. A probe that throws or hangs marks its capability
   * `unavailable` — never `available`, and never left at its previous value.
   */
  async probeAll(timeoutMs = 8_000): Promise<readonly CapabilityRecord[]> {
    const results = await Promise.all(
      [...this.probes.values()].map(async (probe) => this.probeOne(probe, timeoutMs)),
    );
    return results;
  }

  async probeOne(probe: CapabilityProbe, timeoutMs = 8_000): Promise<CapabilityRecord> {
    const nowMs = this.clock.now();
    const context: ProbeContext = { nowMs, logger: this.logger, timeoutMs };

    let outcome: ProbeOutcome;
    try {
      outcome = await withTimeout(probe.probe(context), timeoutMs);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outcome = { state: 'unavailable', detail: `probe failed: ${message}` };
      this.logger.debug('capability probe failed', { capability: probe.descriptor.id, error: message });
    }

    const record = this.buildRecord(probe, outcome, nowMs);
    this.records.set(probe.descriptor.id, record);
    return record;
  }

  private buildRecord(probe: CapabilityProbe, outcome: ProbeOutcome, nowMs: number): CapabilityRecord {
    // Fidelity can only ever be as strong as the provider behind the probe.
    const claimed: Fidelity = outcome.fidelity ?? defaultFidelityFor(outcome.state);
    let fidelity = combineFidelity(probe.trust, claimed);

    let state = outcome.state;
    // A provider that is not live cannot report a live-grade `available`.
    if (state === 'available' && fidelity !== 'live') state = 'mocked';
    if (state === 'mocked' && fidelity === 'live') fidelity = 'mocked';
    if (state === 'unavailable' || state === 'unsupported') fidelity = 'unavailable';
    if (state === 'unverified') fidelity = 'unverified';

    const base: CapabilityRecord = {
      ...probe.descriptor,
      state,
      fidelity,
      detail: outcome.detail,
      probedAtMs: nowMs,
    };
    return outcome.backendVersion === undefined ? base : { ...base, backendVersion: outcome.backendVersion };
  }

  /** Mark every capability unverified again, e.g. after a resume from sleep. */
  invalidate(): void {
    for (const [id, record] of this.records) {
      this.records.set(id, {
        ...record,
        state: 'unverified',
        fidelity: 'unverified',
        detail: 'invalidated; awaiting re-probe',
        probedAtMs: null,
      });
    }
  }
}

function defaultFidelityFor(state: CapabilityState): Fidelity {
  switch (state) {
    case 'available':
      return 'live';
    case 'mocked':
      return 'mocked';
    case 'unverified':
      return 'unverified';
    case 'unavailable':
    case 'unsupported':
      return 'unavailable';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function summarize(records: readonly CapabilityRecord[]): {
  total: number;
  byState: Record<CapabilityState, number>;
  available: string[];
  unavailable: string[];
} {
  const byState: Record<CapabilityState, number> = {
    available: 0,
    unavailable: 0,
    unverified: 0,
    unsupported: 0,
    mocked: 0,
  };
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const record of records) {
    byState[record.state] += 1;
    if (record.state === 'available') available.push(record.id);
    else unavailable.push(record.id);
  }
  return { total: records.length, byState, available, unavailable };
}
