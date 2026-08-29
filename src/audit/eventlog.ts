/**
 * The audit event log.
 *
 * Append-only JSONL, split into bounded segments, with each record carrying
 * the hash of the record before it. That chain means a deleted or edited
 * record is detectable: `verify()` walks the whole log and reports the first
 * point where the chain breaks.
 *
 * Three artifact kinds are kept deliberately distinct across NEXUS:
 *
 *   CHECKPOINT  short-term, pre-change, used to put a setting back
 *   BACKUP      longer-term recovery artifact, kept on purpose
 *   LOG         historical evidence of what happened — this file
 *
 * They have different lifetimes and different pruning rules, and conflating
 * them is how systems end up deleting the only copy of something that mattered.
 *
 * Telemetry is not audited. Sampling every few seconds forever would drown the
 * decisions in noise and grow without bound; only decisions, failures and
 * state transitions are recorded here.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from '../core/canonical-json.js';
import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import { appendLine, ensureDir, fileSize, listFiles, readText, removeFile } from '../core/fsx.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import { redact, scrubString } from '../core/redact.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { AuditEvent, AuditEventInput, EventSeverity } from '../domain/events.js';
import { GENESIS_HASH } from '../domain/events.js';

const SEGMENT_PREFIX = 'events-';
const SEGMENT_SUFFIX = '.jsonl';

export interface EventLogOptions {
  readonly paths: NexusPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessionId: string;
  /** Roll to a new segment past this size. */
  readonly maxSegmentBytes?: number;
  /** Never keep more than this many segments. */
  readonly maxSegments?: number;
  /** Always keep at least this many, even if they are old. */
  readonly minSegments?: number;
  /** Prune segments older than this, subject to `minSegments`. */
  readonly maxAgeMs?: number;
}

/** Severities important enough to flush to disk before continuing. */
const DURABLE_SEVERITIES: ReadonlySet<EventSeverity> = new Set<EventSeverity>(['error', 'critical']);

export function hashEvent(record: Omit<AuditEvent, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

export function segmentName(index: number): string {
  return `${SEGMENT_PREFIX}${String(index).padStart(6, '0')}${SEGMENT_SUFFIX}`;
}

export function segmentIndex(name: string): number | null {
  if (!name.startsWith(SEGMENT_PREFIX) || !name.endsWith(SEGMENT_SUFFIX)) return null;
  const middle = name.slice(SEGMENT_PREFIX.length, -SEGMENT_SUFFIX.length);
  if (!/^\d+$/.test(middle)) return null;
  return Number(middle);
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly recordsChecked: number;
  readonly firstBrokenSeq: number | null;
  readonly reason: string | null;
}

export class EventLog {
  private readonly options: Required<Omit<EventLogOptions, 'paths' | 'clock' | 'logger' | 'sessionId'>> &
    Pick<EventLogOptions, 'paths' | 'clock' | 'logger' | 'sessionId'>;
  private currentIndex = 0;
  private lastHash = GENESIS_HASH;
  private nextSeq = 1;
  private opened = false;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: EventLogOptions) {
    this.options = {
      ...options,
      maxSegmentBytes: options.maxSegmentBytes ?? 2 * 1024 * 1024,
      maxSegments: options.maxSegments ?? 20,
      minSegments: options.minSegments ?? 3,
      maxAgeMs: options.maxAgeMs ?? 90 * 24 * 3_600_000,
    };
  }

  get sequence(): number {
    return this.nextSeq;
  }

  get headHash(): string {
    return this.lastHash;
  }

  private get dir(): string {
    return this.options.paths.events;
  }

  /** Open the log, resuming the chain from whatever is already on disk. */
  async open(): Promise<Result<true, NexusError>> {
    const dirResult = await ensureDir(this.dir);
    if (!dirResult.ok) return dirResult;

    const segments = await this.segments();
    if (segments.length === 0) {
      this.currentIndex = 1;
      this.lastHash = GENESIS_HASH;
      this.nextSeq = 1;
      this.opened = true;
      return ok(true);
    }

    const last = segments[segments.length - 1];
    /* istanbul ignore next - segments is non-empty here */
    if (last === undefined) return err(nexusError('E_INTERNAL', 'segment list is inconsistent'));

    this.currentIndex = last;
    const records = await this.readSegment(last);
    if (!records.ok) return err(records.error);

    const tail = records.value[records.value.length - 1];
    if (tail) {
      this.lastHash = tail.hash;
      this.nextSeq = tail.seq + 1;
    } else {
      this.lastHash = await this.previousSegmentHash(last);
      this.nextSeq = await this.nextSeqFrom(segments, last);
    }

    this.opened = true;
    return ok(true);
  }

  /**
   * Append an event. Writes are serialised through a promise chain so two
   * concurrent callers cannot interleave and produce a broken hash chain.
   */
  async append(input: AuditEventInput): Promise<Result<AuditEvent, NexusError>> {
    if (!this.opened) return err(nexusError('E_STATE', 'event log is not open'));

    const run = this.writeChain.then(() => this.appendUnsafe(input));
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async appendUnsafe(input: AuditEventInput): Promise<Result<AuditEvent, NexusError>> {
    await this.rotateIfNeeded();

    const base: Omit<AuditEvent, 'hash'> = {
      kind: input.kind,
      severity: input.severity,
      // Registered secrets are scrubbed from the message too, not only from
      // `data`: an error string that quoted a token would otherwise reach disk.
      message: scrubString(input.message),
      ...(input.data === undefined ? {} : { data: redact(input.data) as Record<string, unknown> }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      seq: this.nextSeq,
      timestampMs: this.options.clock.now(),
      sessionId: this.options.sessionId,
      prevHash: this.lastHash,
    };

    const record: AuditEvent = { ...base, hash: hashEvent(base) };

    const written = await appendLine(
      this.segmentPath(this.currentIndex),
      canonicalJson(record),
      DURABLE_SEVERITIES.has(record.severity),
    );
    if (!written.ok) return err(written.error);

    this.lastHash = record.hash;
    this.nextSeq += 1;
    return ok(record);
  }

  /** Read every record in order, oldest first. */
  async readAll(limit?: number): Promise<Result<AuditEvent[], NexusError>> {
    const segments = await this.segments();
    const out: AuditEvent[] = [];
    for (const index of segments) {
      const records = await this.readSegment(index);
      if (!records.ok) return err(records.error);
      out.push(...records.value);
    }
    return ok(limit === undefined ? out : out.slice(-limit));
  }

  /** Walk the chain and report the first break, if any. */
  async verify(): Promise<Result<ChainVerification, NexusError>> {
    const all = await this.readAll();
    if (!all.ok) return err(all.error);

    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;

    for (const record of all.value) {
      if (record.seq !== expectedSeq) {
        return ok({
          valid: false,
          recordsChecked: expectedSeq - 1,
          firstBrokenSeq: record.seq,
          reason: `sequence jumped: expected ${expectedSeq}, found ${record.seq}`,
        });
      }
      if (record.prevHash !== expectedPrev) {
        return ok({
          valid: false,
          recordsChecked: expectedSeq - 1,
          firstBrokenSeq: record.seq,
          reason: 'previous-hash link does not match the preceding record',
        });
      }
      const { hash, ...rest } = record;
      if (hashEvent(rest) !== hash) {
        return ok({
          valid: false,
          recordsChecked: expectedSeq - 1,
          firstBrokenSeq: record.seq,
          reason: 'record hash does not match its contents',
        });
      }
      expectedPrev = record.hash;
      expectedSeq += 1;
    }

    return ok({ valid: true, recordsChecked: all.value.length, firstBrokenSeq: null, reason: null });
  }

  /**
   * Prune old segments. Bounded by count and age, and floored by
   * `minSegments` so the log can never be reduced to nothing.
   */
  async prune(): Promise<Result<number, NexusError>> {
    const segments = await this.segments();
    if (segments.length <= this.options.minSegments) return ok(0);

    const cutoff = this.options.clock.now() - this.options.maxAgeMs;
    const removable = segments.slice(0, Math.max(0, segments.length - this.options.minSegments));
    let removed = 0;

    for (const index of removable) {
      const overCount = segments.length - removed > this.options.maxSegments;
      let tooOld = false;
      if (!overCount) {
        const records = await this.readSegment(index);
        const last = records.ok ? records.value[records.value.length - 1] : undefined;
        tooOld = last !== undefined && last.timestampMs < cutoff;
      }
      if (!overCount && !tooOld) continue;
      if (index === this.currentIndex) continue;
      await removeFile(this.segmentPath(index));
      removed += 1;
    }

    if (removed > 0) {
      this.options.logger.info('pruned audit log segments', { removed });
    }
    return ok(removed);
  }

  private segmentPath(index: number): string {
    return path.join(this.dir, segmentName(index));
  }

  private async segments(): Promise<number[]> {
    const files = await listFiles(this.dir);
    return files
      .map(segmentIndex)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
  }

  private async readSegment(index: number): Promise<Result<AuditEvent[], NexusError>> {
    const text = await readText(this.segmentPath(index));
    if (!text.ok) {
      // A missing segment during a read is not fatal; it may have been pruned.
      return text.error.code === 'E_UNAVAILABLE' ? ok([]) : err(text.error);
    }
    const out: AuditEvent[] = [];
    const lines = text.value.split('\n');
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as AuditEvent);
      } catch {
        return err(
          nexusError('E_IO', `audit segment ${index} contains a line that is not valid JSON`, { segment: index }),
        );
      }
    }
    return ok(out);
  }

  private async rotateIfNeeded(): Promise<void> {
    const size = await fileSize(this.segmentPath(this.currentIndex));
    if (size !== null && size >= this.options.maxSegmentBytes) {
      this.currentIndex += 1;
      await this.prune();
    }
  }

  private async previousSegmentHash(index: number): Promise<string> {
    for (let i = index - 1; i >= 1; i -= 1) {
      const records = await this.readSegment(i);
      if (!records.ok) continue;
      const tail = records.value[records.value.length - 1];
      if (tail) return tail.hash;
    }
    return GENESIS_HASH;
  }

  private async nextSeqFrom(segments: readonly number[], current: number): Promise<number> {
    for (const index of [...segments].reverse()) {
      if (index >= current) continue;
      const records = await this.readSegment(index);
      if (!records.ok) continue;
      const tail = records.value[records.value.length - 1];
      if (tail) return tail.seq + 1;
    }
    return 1;
  }
}

/** No-op sink used where an event log is optional (CLI one-shot commands). */
export class NullEventLog {
  async open(): Promise<Result<true, NexusError>> {
    return ok(true);
  }

  async append(): Promise<Result<AuditEvent, NexusError>> {
    return err(nexusError('E_UNAVAILABLE', 'no audit log is attached'));
  }
}
