/**
 * Single-instance enforcement.
 *
 * A PID file is not enough on its own: PIDs are reused, a stale file outlives
 * a crash, and checking "is this PID alive?" says nothing about whether the
 * live process is actually NEXUS. So the authoritative lock is an OS
 * rendezvous point that only one process can hold and that the kernel releases
 * automatically when the holder dies:
 *
 *   Windows  a named pipe. A second `listen` on the same name fails.
 *   POSIX    a unix domain socket. The socket *file* survives a crash, so a
 *            leftover file is probed by connecting to it: a refused connection
 *            means the holder is gone and the file is stale.
 *
 * A descriptive lock file sits alongside it. It carries no authority — it
 * exists so a human (or `nexus doctor`) can see who holds the lock and since
 * when, rather than only being told "something else is running".
 */

import net from 'node:net';
import { hostname } from 'node:os';
import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { nexusError, toNexusError } from '../core/errors.js';
import { ensureDir, readJson, removeFile, writeJson } from '../core/fsx.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import { endpointDiscriminator } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { vNumber, vObject, vString } from '../core/validate.js';

const lockInfoSchema = vObject({
  sessionId: vString({ maxLength: 64 }),
  pid: vNumber({ integer: true, min: 0 }),
  startedAtMs: vNumber({ min: 0 }),
  host: vString({ maxLength: 256 }),
  nexusVersion: vString({ maxLength: 32 }),
  endpoint: vString({ maxLength: 512 }),
});

export interface LockInfo {
  readonly sessionId: string;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly host: string;
  readonly nexusVersion: string;
  readonly endpoint: string;
}

export interface InstanceLockOptions {
  readonly paths: NexusPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessionId: string;
  readonly nexusVersion: string;
  readonly platform?: NodeJS.Platform;
}

export function lockEndpoint(paths: NexusPaths, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\nexus-lock-${endpointDiscriminator(paths.home)}`
    : path.join(paths.runtime, 'instance.lock.sock');
}

export function lockInfoFile(paths: NexusPaths): string {
  return path.join(paths.runtime, 'instance.json');
}

export class InstanceLock {
  private readonly options: InstanceLockOptions;
  private readonly platform: NodeJS.Platform;
  private server: net.Server | null = null;

  constructor(options: InstanceLockOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
  }

  get held(): boolean {
    return this.server !== null;
  }

  get endpoint(): string {
    return lockEndpoint(this.options.paths, this.platform);
  }

  /**
   * Try to become the single instance.
   *
   * Returns `E_CONFLICT` when another instance holds the lock, with the
   * holder's details in `details.holder` when they could be read.
   */
  async acquire(): Promise<Result<LockInfo, NexusError>> {
    const endpoint = this.endpoint;

    // The lock must not depend on someone else having created the directory:
    // it is the first thing to run at startup, before anything else exists.
    const made = await ensureDir(this.options.paths.runtime);
    if (!made.ok) return err(made.error);

    if (this.platform !== 'win32') {
      const stale = await this.probeStaleSocket(endpoint);
      if (!stale.ok) return err(stale.error);
    }

    const bound = await this.bindEndpoint(endpoint);
    if (!bound.ok) {
      const holder = await this.readHolder();
      return err(
        nexusError(
          'E_CONFLICT',
          holder
            ? `another NEXUS instance is already running (session ${holder.sessionId}, pid ${holder.pid} on ${holder.host})`
            : 'another NEXUS instance is already running',
          holder ? { holder } : undefined,
          bound.error,
        ),
      );
    }

    const info: LockInfo = {
      sessionId: this.options.sessionId,
      pid: process.pid,
      startedAtMs: this.options.clock.now(),
      host: hostname(),
      nexusVersion: this.options.nexusVersion,
      endpoint,
    };
    await writeJson(lockInfoFile(this.options.paths), info, { fsyncData: true });
    this.options.logger.debug('instance lock acquired', { endpoint, pid: process.pid });
    return ok(info);
  }

  async release(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await removeFile(lockInfoFile(this.options.paths));
    if (this.platform !== 'win32') await removeFile(this.endpoint);
  }

  async readHolder(): Promise<LockInfo | null> {
    const parsed = await readJson(lockInfoFile(this.options.paths), lockInfoSchema);
    return parsed.ok ? parsed.value : null;
  }

  private async bindEndpoint(endpoint: string): Promise<Result<true, NexusError>> {
    return new Promise<Result<true, NexusError>>((resolve) => {
      // The lock server accepts and immediately closes connections. Its only
      // job is to occupy the name; it carries no protocol.
      const server = net.createServer((socket) => socket.destroy());
      server.unref();

      const onError = (e: Error): void => {
        server.removeListener('listening', onListening);
        resolve(err(toNexusError(e, 'E_CONFLICT')));
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        this.server = server;
        resolve(ok(true));
      };

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen({ path: endpoint });
      } catch (e) {
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        resolve(err(toNexusError(e, 'E_IO')));
      }
    });
  }

  /**
   * On POSIX a crashed process leaves the socket file behind. Connect to it:
   * a refused connection means nothing is listening and the file can go.
   */
  private async probeStaleSocket(endpoint: string): Promise<Result<true, NexusError>> {
    const alive = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ path: endpoint });
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      setTimeout(() => done(false), 500).unref?.();
    });

    if (alive) {
      const holder = await this.readHolder();
      return err(
        nexusError(
          'E_CONFLICT',
          holder
            ? `another NEXUS instance is already running (session ${holder.sessionId}, pid ${holder.pid})`
            : 'another NEXUS instance is already running',
          holder ? { holder } : undefined,
        ),
      );
    }

    await removeFile(endpoint);
    return ok(true);
  }
}
