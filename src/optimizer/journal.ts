/**
 * The operation journal.
 *
 * Applying a change is not atomic: NEXUS captures a checkpoint, writes one or
 * more controls, measures, then decides. A crash can land anywhere in that
 * sequence. The journal records where the operation had got to *before* each
 * step, so a later session can tell the difference between "we never started"
 * and "we wrote two of three controls and then died".
 *
 * The rule on recovery is: never assume an interrupted operation succeeded.
 * Anything not in a terminal state is rolled back if it can be, and reported
 * as unresolved if it cannot.
 */

import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { listFiles, readJson, removeFile, writeJson } from '../core/fsx.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { vArray, vNullable, vNumber, vObject, vString } from '../core/validate.js';
import type { ControlId } from '../domain/control.js';

export const OPERATION_STATUSES = [
  /** Journalled, nothing touched yet. */
  'intent',
  /** Prior values captured. Safe to abandon. */
  'checkpointed',
  /** At least one write has been issued. The machine may be modified. */
  'applying',
  /** All writes issued and verified. */
  'applied',
  /** Measuring the effect. */
  'measuring',
  /* terminal */
  'committed',
  'rolled_back',
  'failed',
  /** Interrupted and reconciled by recovery. */
  'abandoned',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<OperationStatus> = new Set<OperationStatus>([
  'committed',
  'rolled_back',
  'failed',
  'abandoned',
]);

/** Statuses where the machine may have been modified and not yet settled. */
export const IN_FLIGHT_MUTATING: ReadonlySet<OperationStatus> = new Set<OperationStatus>([
  'applying',
  'applied',
  'measuring',
]);

export interface OperationRecord {
  readonly id: string;
  readonly proposalId: string;
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly status: OperationStatus;
  readonly checkpointId: string | null;
  readonly controls: readonly ControlId[];
  /** Controls whose write has been issued. */
  readonly appliedControls: readonly ControlId[];
  readonly detail: string;
}

const recordSchema = vObject({
  id: vString({ maxLength: 64 }),
  proposalId: vString({ maxLength: 64 }),
  sessionId: vString({ maxLength: 64 }),
  startedAtMs: vNumber({ min: 0 }),
  updatedAtMs: vNumber({ min: 0 }),
  status: vString({ maxLength: 32 }),
  checkpointId: vNullable(vString({ maxLength: 64 })),
  controls: vArray(vString({ maxLength: 128 }), { maxItems: 64 }),
  appliedControls: vArray(vString({ maxLength: 128 }), { maxItems: 64 }),
  detail: vString({ maxLength: 512 }),
});

export class OperationJournal {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly sessionId: string;

  constructor(paths: NexusPaths, clock: Clock, sessionId: string) {
    this.dir = path.join(paths.state, 'operations');
    this.clock = clock;
    this.sessionId = sessionId;
  }

  async record(
    id: string,
    proposalId: string,
    controls: readonly ControlId[],
  ): Promise<Result<OperationRecord, NexusError>> {
    const now = this.clock.now();
    const record: OperationRecord = {
      id,
      proposalId,
      sessionId: this.sessionId,
      startedAtMs: now,
      updatedAtMs: now,
      status: 'intent',
      checkpointId: null,
      controls,
      appliedControls: [],
      detail: 'operation journalled; nothing has been changed',
    };
    const written = await writeJson(this.file(id), record, { fsyncData: true });
    return written.ok ? ok(record) : err(written.error);
  }

  /**
   * Advance an operation. Written with fsync because a journal entry that is
   * still in the page cache when the machine loses power is worthless.
   */
  async advance(
    record: OperationRecord,
    status: OperationStatus,
    detail: string,
    patch: Partial<Pick<OperationRecord, 'checkpointId' | 'appliedControls'>> = {},
  ): Promise<Result<OperationRecord, NexusError>> {
    const next: OperationRecord = {
      ...record,
      ...patch,
      status,
      detail,
      updatedAtMs: this.clock.now(),
    };
    const written = await writeJson(this.file(record.id), next, { fsyncData: true });
    return written.ok ? ok(next) : err(written.error);
  }

  async load(id: string): Promise<Result<OperationRecord, NexusError>> {
    const parsed = await readJson(this.file(id), recordSchema);
    return parsed.ok ? ok(parsed.value as OperationRecord) : err(parsed.error);
  }

  async list(): Promise<readonly OperationRecord[]> {
    const out: OperationRecord[] = [];
    for (const file of await listFiles(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const parsed = await readJson(path.join(this.dir, file), recordSchema);
      if (parsed.ok) out.push(parsed.value as OperationRecord);
    }
    return out.sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  /** Operations left unfinished by a previous session. */
  async unfinished(): Promise<readonly OperationRecord[]> {
    return (await this.list()).filter((r) => !TERMINAL_STATUSES.has(r.status));
  }

  /** Remove terminal records older than the retention window. */
  async prune(maxAgeMs = 7 * 24 * 3_600_000): Promise<number> {
    const cutoff = this.clock.now() - maxAgeMs;
    let removed = 0;
    for (const record of await this.list()) {
      if (!TERMINAL_STATUSES.has(record.status)) continue;
      if (record.updatedAtMs >= cutoff) continue;
      await removeFile(this.file(record.id));
      removed += 1;
    }
    return removed;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }
}
