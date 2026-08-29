/**
 * Checkpoints.
 *
 * A checkpoint records the exact prior value of every control an operation is
 * about to touch, before it touches any of them. Restoring one may only write
 * the controls it captured — the scope is the checkpoint's contents, and there
 * is no code path that widens it.
 *
 * Two things a checkpoint deliberately does not do:
 *
 *   - It does not claim to reverse something irreversible. A control whose
 *     prior value could not be read is recorded as *not restorable*, and its
 *     presence makes the whole checkpoint partial.
 *   - It does not silently succeed. A restore that cannot verify the value it
 *     wrote reports failure, so the caller fails closed rather than assuming
 *     the machine is back where it started.
 *
 * A checkpoint is short-term recovery state, distinct from a backup (a
 * deliberate longer-term artifact) and from the audit log (evidence). They are
 * stored separately and pruned by different rules.
 */

import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import { listFiles, readJson, removeFile, writeJson } from '../core/fsx.js';
import type { IdSource } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import {
  vArray,
  vBoolean,
  vNullable,
  vNumber,
  vObject,
  vOptional,
  vString,
  vUnion,
} from '../core/validate.js';
import type { ControlId, ControlValue } from '../domain/control.js';
import type { ActuatorContext, ControlAdapter , ActuatorRegistry} from '../optimizer/actuator.js';
import { writeAndVerify } from '../optimizer/actuator.js';

const controlValueSchema = vUnion(vString({ maxLength: 256 }), vNumber(), vBoolean());

const entrySchema = vObject({
  control: vString({ maxLength: 128 }),
  previousValue: vNullable(controlValueSchema),
  restorable: vBoolean(),
  reason: vOptional(vString({ maxLength: 256 })),
  adapterId: vString({ maxLength: 128 }),
});

const checkpointSchema = vObject({
  id: vString({ maxLength: 64 }),
  createdAtMs: vNumber({ min: 0 }),
  sessionId: vString({ maxLength: 64 }),
  reason: vString({ maxLength: 512 }),
  correlationId: vOptional(vString({ maxLength: 64 })),
  entries: vArray(entrySchema, { maxItems: 64 }),
  /** True when at least one control could not be captured. */
  partial: vBoolean(),
});

export interface CheckpointEntry {
  readonly control: ControlId;
  readonly previousValue: ControlValue | null;
  readonly restorable: boolean;
  readonly reason?: string | undefined;
  readonly adapterId: string;
}

export interface Checkpoint {
  readonly id: string;
  readonly createdAtMs: number;
  readonly sessionId: string;
  readonly reason: string;
  readonly correlationId?: string | undefined;
  readonly entries: readonly CheckpointEntry[];
  readonly partial: boolean;
}

export interface RestoreEntryResult {
  readonly control: ControlId;
  readonly restored: boolean;
  readonly verified: boolean;
  readonly message: string;
}

export interface RestoreResult {
  readonly checkpointId: string;
  readonly complete: boolean;
  readonly entries: readonly RestoreEntryResult[];
}

export interface CheckpointStoreOptions {
  readonly paths: NexusPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ids: IdSource;
  readonly sessionId: string;
  readonly registry: ActuatorRegistry;
  /** Keep at most this many checkpoints; oldest are pruned first. */
  readonly maxCheckpoints?: number;
}

export class CheckpointStore {
  private readonly options: CheckpointStoreOptions;
  private readonly maxCheckpoints: number;

  constructor(options: CheckpointStoreOptions) {
    this.options = options;
    this.maxCheckpoints = options.maxCheckpoints ?? 50;
  }

  /**
   * Capture the current value of each control. Called before any write.
   *
   * A control whose value cannot be read is recorded as not restorable rather
   * than omitted, so the record shows what was attempted.
   */
  async capture(
    controls: readonly ControlId[],
    reason: string,
    context: ActuatorContext,
    correlationId?: string,
  ): Promise<Result<Checkpoint, NexusError>> {
    if (controls.length === 0) {
      return err(nexusError('E_INVALID_INPUT', 'a checkpoint must name at least one control'));
    }

    const entries: CheckpointEntry[] = [];
    for (const control of controls) {
      const adapter = this.options.registry.get(control);
      if (!adapter) {
        entries.push({
          control,
          previousValue: null,
          restorable: false,
          reason: 'no adapter is registered for this control',
          adapterId: 'none',
        });
        continue;
      }
      const value = await adapter.read(context);
      if (!value.ok) {
        entries.push({
          control,
          previousValue: null,
          restorable: false,
          reason: `could not read the current value: ${value.error.message}`,
          adapterId: adapter.id,
        });
        continue;
      }
      if (value.value === null) {
        entries.push({
          control,
          previousValue: null,
          restorable: false,
          reason: 'the control reported no current value, so there is nothing to restore to',
          adapterId: adapter.id,
        });
        continue;
      }
      entries.push({
        control,
        previousValue: value.value,
        restorable: true,
        adapterId: adapter.id,
      });
    }

    const checkpoint: Checkpoint = {
      id: this.options.ids.next('ckpt'),
      createdAtMs: this.options.clock.now(),
      sessionId: this.options.sessionId,
      reason,
      ...(correlationId === undefined ? {} : { correlationId }),
      entries,
      partial: entries.some((e) => !e.restorable),
    };

    const written = await writeJson(this.file(checkpoint.id), checkpoint, { fsyncData: true });
    if (!written.ok) return err(written.error);

    await this.prune();
    return ok(checkpoint);
  }

  async load(id: string): Promise<Result<Checkpoint, NexusError>> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return err(nexusError('E_INVALID_INPUT', `invalid checkpoint id: ${id}`));
    }
    return readJson(this.file(id), checkpointSchema);
  }

  async list(): Promise<readonly string[]> {
    const files = await listFiles(this.options.paths.checkpoints);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  /**
   * Restore a checkpoint.
   *
   * `only` may narrow the set of controls to restore; it can never extend it.
   * A control not present in the checkpoint is refused, which is what stops a
   * rollback from reaching outside its intended scope.
   */
  async restore(
    id: string,
    context: ActuatorContext,
    only?: readonly ControlId[],
  ): Promise<Result<RestoreResult, NexusError>> {
    const loaded = await this.load(id);
    if (!loaded.ok) return err(loaded.error);
    const checkpoint = loaded.value;

    if (only) {
      const captured = new Set(checkpoint.entries.map((e) => e.control));
      const outside = only.filter((c) => !captured.has(c));
      if (outside.length > 0) {
        return err(
          nexusError(
            'E_INVALID_INPUT',
            `rollback scope error: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not part of checkpoint ${id}`,
            { checkpointId: id, outside },
          ),
        );
      }
    }

    const wanted = only ? new Set(only) : null;
    const results: RestoreEntryResult[] = [];

    for (const entry of checkpoint.entries) {
      if (wanted && !wanted.has(entry.control)) continue;

      if (!entry.restorable || entry.previousValue === null) {
        results.push({
          control: entry.control,
          restored: false,
          verified: false,
          message: entry.reason ?? 'this control was not captured and cannot be restored',
        });
        continue;
      }

      const adapter: ControlAdapter | undefined = this.options.registry.get(entry.control);
      if (!adapter) {
        results.push({
          control: entry.control,
          restored: false,
          verified: false,
          message: 'no adapter is registered for this control any more',
        });
        continue;
      }

      const written = await writeAndVerify(adapter, context, entry.previousValue);
      if (!written.ok) {
        results.push({
          control: entry.control,
          restored: false,
          verified: false,
          message: `restore failed: ${written.error.message}`,
        });
        continue;
      }
      results.push({
        control: entry.control,
        restored: true,
        verified: written.value.verified,
        message: written.value.verified
          ? 'restored and verified'
          : `restored, but reading it back returned ${JSON.stringify(written.value.observed)}`,
      });
    }

    const complete = results.length > 0 && results.every((r) => r.restored && r.verified);
    return ok({ checkpointId: id, complete, entries: results });
  }

  private file(id: string): string {
    return path.join(this.options.paths.checkpoints, `${id}.json`);
  }

  /** Bounded storage. Oldest checkpoints go first; the newest always stays. */
  private async prune(): Promise<void> {
    const ids = await this.list();
    if (ids.length <= this.maxCheckpoints) return;
    const excess = ids.length - this.maxCheckpoints;

    const dated: { id: string; createdAtMs: number }[] = [];
    for (const id of ids) {
      const loaded = await this.load(id);
      dated.push({ id, createdAtMs: loaded.ok ? loaded.value.createdAtMs : 0 });
    }
    dated.sort((a, b) => a.createdAtMs - b.createdAtMs);

    for (const { id } of dated.slice(0, excess)) {
      await removeFile(this.file(id));
    }
    this.options.logger.debug('pruned checkpoints', { removed: excess });
  }
}
