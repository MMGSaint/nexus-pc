/**
 * Durable session state and the restart guard.
 *
 * Two questions have to survive a power cut:
 *
 *   1. Did the previous session end cleanly, or did it die? A session record
 *      written at startup with `cleanShutdown: false`, and updated only by an
 *      orderly shutdown, answers that without guessing.
 *   2. Is NEXUS restart-looping? A crash on startup that immediately restarts
 *      is worse than staying down. Start timestamps are counted in a rolling
 *      window, and past the threshold NEXUS comes up in observation-only mode
 *      instead of trying the thing that killed it again.
 */

import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { readJson, writeJson } from '../core/fsx.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { ok } from '../core/result.js';
import { vArray, vBoolean, vNullable, vNumber, vObject, vString } from '../core/validate.js';
import type { RunState, ShutdownKind } from '../domain/health.js';

const sessionSchema = vObject({
  sessionId: vString({ maxLength: 64 }),
  pid: vNumber({ integer: true, min: 0 }),
  nexusVersion: vString({ maxLength: 32 }),
  startedAtMs: vNumber({ min: 0 }),
  lastHeartbeatMs: vNumber({ min: 0 }),
  endedAtMs: vNullable(vNumber({ min: 0 })),
  cleanShutdown: vBoolean(),
  runState: vString({ maxLength: 32 }),
});

export interface SessionRecord {
  readonly sessionId: string;
  readonly pid: number;
  readonly nexusVersion: string;
  readonly startedAtMs: number;
  readonly lastHeartbeatMs: number;
  readonly endedAtMs: number | null;
  readonly cleanShutdown: boolean;
  readonly runState: string;
}

const restartSchema = vObject({
  starts: vArray(vNumber({ min: 0 }), { maxItems: 128 }),
});

export interface RestartVerdict {
  readonly startsInWindow: number;
  readonly looping: boolean;
  readonly reason: string | null;
}

export interface SessionStoreOptions {
  readonly paths: NexusPaths;
  readonly clock: Clock;
  readonly sessionId: string;
  readonly nexusVersion: string;
  /** Starts allowed inside the window before NEXUS treats itself as looping. */
  readonly maxStartsInWindow?: number;
  readonly restartWindowMs?: number;
}

export class SessionStore {
  private readonly options: Required<SessionStoreOptions>;
  private current: SessionRecord | null = null;

  constructor(options: SessionStoreOptions) {
    this.options = {
      ...options,
      maxStartsInWindow: options.maxStartsInWindow ?? 5,
      restartWindowMs: options.restartWindowMs ?? 300_000,
    };
  }

  private get sessionFile(): string {
    return path.join(this.options.paths.state, 'session.json');
  }

  private get restartFile(): string {
    return path.join(this.options.paths.state, 'restarts.json');
  }

  /** The previous session's record, read before it is overwritten. */
  async previous(): Promise<SessionRecord | null> {
    const parsed = await readJson(this.sessionFile, sessionSchema);
    return parsed.ok ? (parsed.value as SessionRecord) : null;
  }

  /** How the previous session ended. */
  static classifyShutdown(previous: SessionRecord | null): ShutdownKind {
    if (!previous) return 'never_started';
    if (previous.cleanShutdown) return 'clean';
    // The record exists and was never marked clean: the process did not get to
    // run its shutdown path.
    return 'crash';
  }

  /** Record the start of this session and evaluate the restart guard. */
  async begin(): Promise<Result<{ record: SessionRecord; restart: RestartVerdict }, NexusError>> {
    const now = this.options.clock.now();

    const parsed = await readJson(this.restartFile, restartSchema);
    const previousStarts = parsed.ok ? parsed.value.starts : [];
    const recent = previousStarts.filter((t) => now - t < this.options.restartWindowMs);
    recent.push(now);
    await writeJson(this.restartFile, { starts: recent.slice(-64) }, { fsyncData: true });

    const looping = recent.length > this.options.maxStartsInWindow;
    const restart: RestartVerdict = {
      startsInWindow: recent.length,
      looping,
      reason: looping
        ? `NEXUS has started ${recent.length} times in the last ${Math.round(this.options.restartWindowMs / 60_000)} minutes. Starting in observation-only mode instead of repeating whatever is failing.`
        : null,
    };

    const record: SessionRecord = {
      sessionId: this.options.sessionId,
      pid: process.pid,
      nexusVersion: this.options.nexusVersion,
      startedAtMs: now,
      lastHeartbeatMs: now,
      endedAtMs: null,
      cleanShutdown: false,
      runState: 'initializing',
    };
    this.current = record;
    const written = await writeJson(this.sessionFile, record, { fsyncData: true });
    if (!written.ok) return written;
    return ok({ record, restart });
  }

  async heartbeat(runState: RunState): Promise<void> {
    if (!this.current) return;
    this.current = {
      ...this.current,
      lastHeartbeatMs: this.options.clock.now(),
      runState,
    };
    await writeJson(this.sessionFile, this.current);
  }

  /** Mark the session as having ended cleanly. Only the shutdown path calls this. */
  async end(runState: RunState): Promise<void> {
    if (!this.current) return;
    const now = this.options.clock.now();
    this.current = {
      ...this.current,
      lastHeartbeatMs: now,
      endedAtMs: now,
      cleanShutdown: true,
      runState,
    };
    await writeJson(this.sessionFile, this.current, { fsyncData: true });
    await this.archive(this.current);
  }

  /** Clear the restart counter once a session has proven itself stable. */
  async markStable(): Promise<void> {
    await writeJson(this.restartFile, { starts: [] });
  }

  private async archive(record: SessionRecord): Promise<void> {
    await writeJson(path.join(this.options.paths.state, 'sessions', `${record.sessionId}.json`), record);
  }
}
