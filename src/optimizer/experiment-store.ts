import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import { ensureDir, listFiles, readJson, writeJson, removeFile } from '../core/fsx.js';
import { vNullable, vNumber, vObject, vString, vUnknown } from '../core/validate.js';
import type { ControlValue } from '../domain/control.js';
import type { ExperimentFingerprint } from './experiment-plan.js';

export interface ExperimentRecord {
  readonly id: string;
  readonly fingerprint: ExperimentFingerprint;
  readonly applicationId: string;
  readonly candidate: Readonly<Record<string, ControlValue>>;
  readonly decision: 'keep' | 'rollback' | 'inconclusive';
  readonly scorePercent: number | null;
  readonly confidenceLowPercent: number | null;
  readonly confidenceHighPercent: number | null;
  readonly createdAtMs: number;
  readonly detail: string;
}

const schema = vObject({
  id: vString({ maxLength: 64 }),
  fingerprint: vUnknown(),
  applicationId: vString({ maxLength: 128 }),
  candidate: vUnknown(),
  decision: vString({ maxLength: 32 }),
  scorePercent: vNullable(vNumber()),
  confidenceLowPercent: vNullable(vNumber()),
  confidenceHighPercent: vNullable(vNumber()),
  createdAtMs: vNumber({ min: 0 }),
  detail: vString({ maxLength: 2000 }),
});

function safeId(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export class ExperimentStore {
  private readonly root: string;

  constructor(
    paths: NexusPaths,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.root = path.join(paths.state, 'experiments');
  }

  async save(record: ExperimentRecord): Promise<Result<true, NexusError>> {
    if (!safeId(record.fingerprint.value)) {
      return err(nexusError('E_INVALID_INPUT', 'experiment fingerprint is not a SHA-256 hex digest'));
    }
    const ready = await ensureDir(this.root);
    if (!ready.ok) return ready;
    const result = await writeJson(this.file(record.fingerprint.value), record, { fsyncData: true });
    if (result.ok) this.logger.info('experiment record saved', { id: record.id, applicationId: record.applicationId });
    return result;
  }

  async find(fingerprint: ExperimentFingerprint): Promise<Result<ExperimentRecord | null, NexusError>> {
    if (!safeId(fingerprint.value)) return err(nexusError('E_INVALID_INPUT', 'experiment fingerprint is invalid'));
    const loaded = await readJson(this.file(fingerprint.value), schema);
    if (!loaded.ok) {
      if (loaded.error.code === 'E_UNAVAILABLE') return ok(null);
      return err(loaded.error);
    }
    return ok(loaded.value as unknown as ExperimentRecord);
  }

  async list(limit = 50): Promise<readonly ExperimentRecord[]> {
    const files = await listFiles(this.root);
    const records: ExperimentRecord[] = [];
    for (const name of files.filter((x) => x.endsWith('.json')).slice(0, Math.max(1, Math.min(500, limit)))) {
      const loaded = await readJson(path.join(this.root, name), schema);
      if (loaded.ok) records.push(loaded.value as unknown as ExperimentRecord);
    }
    return records.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async remove(fingerprint: ExperimentFingerprint): Promise<void> {
    if (safeId(fingerprint.value)) await removeFile(this.file(fingerprint.value));
  }

  now(): number {
    return this.clock.now();
  }

  private file(fingerprint: string): string {
    return path.join(this.root, `${fingerprint}.json`);
  }
}
