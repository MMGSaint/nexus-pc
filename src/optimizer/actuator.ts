/**
 * Control adapters — the only code that reads or writes a machine setting.
 *
 * Every adapter must be able to *read* its control. That is not a convenience:
 * without a read there is no checkpoint, without a checkpoint there is no
 * rollback, and without rollback the change should not be attempted at all.
 * An adapter whose read fails makes its control unusable, by design.
 *
 * Adapters carry a trust level. The registry reports it to the safety kernel
 * and to the optimizer, so an outcome produced through a mock adapter is
 * labelled `mocked` all the way out to Vesper.
 */

import type { Clock } from '../core/clock.js';
import type { CommandRunner } from '../core/exec.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import type { Fidelity } from '../core/fidelity.js';
import type { Logger } from '../core/logger.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { ControlId, ControlValue } from '../domain/control.js';
import { structurallyEqual } from '../core/canonical-json.js';

export interface ActuatorContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runner: CommandRunner;
  readonly timeoutMs: number;
}

export interface ControlAdapter {
  readonly id: string;
  readonly control: ControlId;
  readonly trust: Fidelity;
  /** Confirm the adapter can operate here. Determines capability availability. */
  probe(context: ActuatorContext): Promise<Result<true, NexusError>>;
  read(context: ActuatorContext): Promise<Result<ControlValue | null, NexusError>>;
  write(context: ActuatorContext, value: ControlValue): Promise<Result<true, NexusError>>;
}

export class ActuatorRegistry {
  private readonly adapters = new Map<ControlId, ControlAdapter>();

  register(adapter: ControlAdapter): void {
    this.adapters.set(adapter.control, adapter);
  }

  get(control: ControlId): ControlAdapter | undefined {
    return this.adapters.get(control);
  }

  has(control: ControlId): boolean {
    return this.adapters.has(control);
  }

  controls(): readonly ControlId[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * Fidelity of the adapter that would perform a change. An absent adapter is
   * `unavailable`, which the safety kernel treats as blocking.
   */
  fidelityOf(control: ControlId): Fidelity {
    return this.adapters.get(control)?.trust ?? 'unavailable';
  }

  /** Weakest fidelity across a set of controls. */
  combinedFidelity(controls: readonly ControlId[]): Fidelity {
    if (controls.length === 0) return 'unavailable';
    const rank: Record<Fidelity, number> = { unavailable: 0, mocked: 1, simulated: 2, unverified: 3, live: 4 };
    let weakest: Fidelity = 'live';
    for (const control of controls) {
      const f = this.fidelityOf(control);
      if (rank[f] < rank[weakest]) weakest = f;
    }
    return weakest;
  }
}

/**
 * Write, then read back and confirm. A write that reports success but does not
 * change the observable value is treated as a failure, because from NEXUS's
 * point of view nothing happened and the checkpoint would be misleading.
 */
export async function writeAndVerify(
  adapter: ControlAdapter,
  context: ActuatorContext,
  value: ControlValue,
): Promise<Result<{ verified: boolean; observed: ControlValue | null }, NexusError>> {
  const written = await adapter.write(context, value);
  if (!written.ok) return err(written.error);

  const readBack = await adapter.read(context);
  if (!readBack.ok) {
    return err(
      nexusError(
        'E_VERIFY_FAILED',
        `wrote "${adapter.control}" but could not read it back: ${readBack.error.message}`,
        { control: adapter.control },
        readBack.error,
      ),
    );
  }

  return ok({ verified: structurallyEqual(readBack.value, value), observed: readBack.value });
}

/* ------------------------------------------------------------------ mock */

export interface MockAdapterOptions {
  readonly initial: ControlValue;
  /** Make the read fail, to exercise the "cannot checkpoint" path. */
  readonly readFails?: boolean;
  readonly writeFails?: boolean;
  /** Accept the write but do not change the value — models a silent no-op. */
  readonly writeSilentlyIgnored?: boolean;
  readonly probeFails?: boolean;
}

/**
 * In-memory adapter used for simulation and tests. Its trust is `mocked`, so
 * nothing it does can ever be reported as a live hardware change.
 */
export class MockControlAdapter implements ControlAdapter {
  readonly id: string;
  readonly control: ControlId;
  readonly trust = 'mocked' as const;

  private value: ControlValue;
  private readonly options: MockAdapterOptions;
  readonly writes: ControlValue[] = [];

  constructor(control: ControlId, options: MockAdapterOptions) {
    this.control = control;
    this.id = `mock:${control}`;
    this.value = options.initial;
    this.options = options;
  }

  get current(): ControlValue {
    return this.value;
  }

  async probe(): Promise<Result<true, NexusError>> {
    return this.options.probeFails
      ? err(nexusError('E_UNAVAILABLE', `mock adapter for ${this.control} is configured to fail probing`))
      : ok(true);
  }

  async read(): Promise<Result<ControlValue | null, NexusError>> {
    return this.options.readFails
      ? err(nexusError('E_UNAVAILABLE', `mock adapter for ${this.control} cannot read`))
      : ok(this.value);
  }

  async write(_context: ActuatorContext, value: ControlValue): Promise<Result<true, NexusError>> {
    if (this.options.writeFails) {
      return err(nexusError('E_IO', `mock adapter for ${this.control} is configured to fail writes`));
    }
    this.writes.push(value);
    if (!this.options.writeSilentlyIgnored) this.value = value;
    return ok(true);
  }
}
