/**
 * A long-lived PowerShell host.
 *
 * Spawning `powershell.exe` costs roughly 200-700 ms of process startup. A
 * telemetry loop that pays that every few seconds would burn more CPU watching
 * the machine than most optimizations could ever win back, which would make
 * NEXUS a net negative on its own terms. So the host is started once and
 * driven over stdin/stdout with a line protocol.
 *
 * Protocol: NEXUS writes one command name per line. The host replies with
 * exactly one line per command, `NEXUSJSON <compact json>`. A `NEXUSREADY`
 * line signals that the host has finished loading.
 *
 * The host is restarted on failure with bounded attempts and backoff — never
 * in an unbounded loop.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import type { Clock } from './clock.js';
import type { NexusError } from './errors.js';
import { nexusError, toNexusError } from './errors.js';
import type { Logger } from './logger.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';
import { isAllowedExecutable } from './exec.js';

export const READY_MARKER = 'NEXUSREADY';
export const JSON_PREFIX = 'NEXUSJSON ';

export type SpawnLike = (
  file: string,
  args: readonly string[],
) => ChildProcessWithoutNullStreams;

export interface PersistentShellOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRestarts?: number;
  readonly restartWindowMs?: number;
  readonly maxLineBytes?: number;
  /** Injected for tests; defaults to `child_process.spawn`. */
  readonly spawnFn?: SpawnLike;
}

interface Pending {
  readonly resolve: (value: Result<unknown, NexusError>) => void;
  readonly timer: NodeJS.Timeout;
}

export class PersistentShell {
  private readonly options: Required<Omit<PersistentShellOptions, 'spawnFn'>> & { spawnFn: SpawnLike };
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private ready = false;
  private readyWaiters: ((r: Result<true, NexusError>) => void)[] = [];
  private queue: Pending[] = [];
  private restarts: number[] = [];
  private stopped = false;
  private starting: Promise<Result<true, NexusError>> | null = null;

  constructor(options: PersistentShellOptions) {
    this.options = {
      file: options.file,
      args: options.args,
      clock: options.clock,
      logger: options.logger.child('shell'),
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 8_000,
      maxRestarts: options.maxRestarts ?? 3,
      restartWindowMs: options.restartWindowMs ?? 300_000,
      maxLineBytes: options.maxLineBytes ?? 1024 * 1024,
      spawnFn: options.spawnFn ?? ((file, args) => spawn(file, [...args], { windowsHide: true, shell: false }) as ChildProcessWithoutNullStreams),
    };
  }

  get isRunning(): boolean {
    return this.child !== null && this.ready;
  }

  async start(): Promise<Result<true, NexusError>> {
    if (this.stopped) return err(nexusError('E_STATE', 'shell has been stopped'));
    if (this.isRunning) return ok(true);
    if (this.starting) return this.starting;

    if (!isAllowedExecutable(this.options.file)) {
      return err(nexusError('E_INVALID_INPUT', `executable is not on the NEXUS allowlist: ${this.options.file}`));
    }

    const now = this.options.clock.now();
    this.restarts = this.restarts.filter((t) => now - t < this.options.restartWindowMs);
    if (this.restarts.length >= this.options.maxRestarts) {
      return err(
        nexusError('E_LIMIT', `sensor host restarted ${this.restarts.length} times in the last ${Math.round(this.options.restartWindowMs / 1000)}s; not restarting again`),
      );
    }
    this.restarts.push(now);

    this.starting = new Promise<Result<true, NexusError>>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.options.spawnFn(this.options.file, this.options.args);
      } catch (e) {
        resolve(err(toNexusError(e, 'E_UNAVAILABLE')));
        return;
      }

      this.child = child;
      this.buffer = '';
      this.ready = false;

      const timer = setTimeout(() => {
        this.failStartup(nexusError('E_TIMEOUT', 'sensor host did not signal ready in time'));
      }, this.options.startupTimeoutMs);
      timer.unref?.();

      this.readyWaiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.options.logger.debug('sensor host stderr', { text: chunk.slice(0, 400) });
      });
      child.on('error', (e) => this.onExit(toNexusError(e, 'E_UNAVAILABLE')));
      child.on('close', () => this.onExit(nexusError('E_UNAVAILABLE', 'sensor host exited')));
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  /** Send one command and await its single JSON reply. */
  async request(command: string, timeoutMs?: number): Promise<Result<unknown, NexusError>> {
    if (!/^[a-z][a-z0-9_.-]{0,31}$/.test(command)) {
      return err(nexusError('E_INVALID_INPUT', `invalid sensor host command: ${command}`));
    }
    const started = await this.start();
    if (!started.ok) return err(started.error);

    const child = this.child;
    if (!child || !this.ready) return err(nexusError('E_UNAVAILABLE', 'sensor host is not ready'));

    return new Promise<Result<unknown, NexusError>>((resolve) => {
      const timer = setTimeout(() => {
        this.dequeue(entry)?.resolve(err(nexusError('E_TIMEOUT', `sensor host did not answer "${command}" in time`)));
        // A host that stops answering is restarted rather than trusted again.
        this.kill();
      }, timeoutMs ?? this.options.requestTimeoutMs);
      timer.unref?.();

      const entry: Pending = { resolve, timer };
      this.queue.push(entry);

      try {
        child.stdin.write(`${command}\n`);
      } catch (e) {
        this.dequeue(entry)?.resolve(err(toNexusError(e, 'E_IO')));
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.write('exit\n');
      child.stdin.end();
    } catch {
      /* the host may already be gone */
    }
    this.kill();
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.options.maxLineBytes) {
      this.buffer = '';
      this.options.logger.warn('sensor host output exceeded the line budget; discarding');
      this.kill();
      return;
    }

    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    if (line === READY_MARKER) {
      this.ready = true;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w(ok(true));
      return;
    }
    if (!line.startsWith(JSON_PREFIX)) return;

    const entry = this.queue.shift();
    if (!entry) return;
    clearTimeout(entry.timer);

    try {
      entry.resolve(ok(JSON.parse(line.slice(JSON_PREFIX.length))));
    } catch (e) {
      entry.resolve(err(nexusError('E_IO', 'sensor host produced invalid JSON', undefined, e)));
    }
  }

  private dequeue(entry: Pending): Pending | null {
    const index = this.queue.indexOf(entry);
    if (index < 0) return null;
    this.queue.splice(index, 1);
    clearTimeout(entry.timer);
    return entry;
  }

  private failStartup(error: NexusError): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w(err(error));
    this.kill();
  }

  private onExit(error: NexusError): void {
    this.ready = false;
    this.child = null;
    this.failStartup(error);
    const queued = this.queue;
    this.queue = [];
    for (const entry of queued) {
      clearTimeout(entry.timer);
      entry.resolve(err(error));
    }
  }
}
