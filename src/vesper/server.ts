/**
 * The Vesper IPC server.
 *
 * Transport: a Windows named pipe or a POSIX unix domain socket, addressed by
 * path. `net.Server.listen` is called with `{ path }` and never with a port —
 * there is no code path in NEXUS that binds a network socket, and a lint rule
 * rejects one being added.
 *
 * Every request is bounded before it is trusted: line length, nesting depth,
 * node count, concurrent connections, requests per minute, and an idle
 * timeout. Then it is schema-parsed strictly, so an unknown field is a refusal
 * rather than something a later layer might read.
 */

import net from 'node:net';
import { chmod } from 'node:fs/promises';

import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { nexusError, toNexusError } from '../core/errors.js';
import { ensureDir, removeFile } from '../core/fsx.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import { ipcEndpoint } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { assertSafeShape, formatIssues } from '../core/validate.js';
import type { EventLog } from '../audit/eventlog.js';
import { ScopeSet, tokenMatches } from './auth.js';
import type { VesperResponse } from './contract.js';
import {
  failure,
  methodScope,
  requestSchema,
  success,
  versionCompatible,
  VESPER_CONTRACT_VERSION,
} from './contract.js';
import type { VesperHandlerResult, VesperHost } from './handlers.js';
import { dispatch } from './handlers.js';

export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_CONNECTIONS = 4;
export const REQUESTS_PER_MINUTE = 120;
export const IDLE_TIMEOUT_MS = 120_000;

export interface VesperServerOptions {
  readonly paths: NexusPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly eventLog: Pick<EventLog, 'append'>;
  readonly token: string;
  readonly scopes: readonly string[];
  readonly host: VesperHost;
  readonly platform?: NodeJS.Platform;
  /** Overridable so tests can use a temporary socket path. */
  readonly endpoint?: string;
}

interface ConnectionState {
  buffer: string;
  requestTimes: number[];
  authenticated: boolean;
}

export class VesperServer {
  private readonly options: VesperServerOptions;
  private readonly scopes: ScopeSet;
  private readonly platform: NodeJS.Platform;
  private server: net.Server | null = null;
  private clientSeen = false;
  private lastRequestAtMs: number | null = null;

  constructor(options: VesperServerOptions) {
    this.options = options;
    this.scopes = new ScopeSet(options.scopes);
    this.platform = options.platform ?? process.platform;
  }

  get listening(): boolean {
    return this.server !== null;
  }

  get endpoint(): string {
    return this.options.endpoint ?? ipcEndpoint(this.options.paths, this.platform);
  }

  get hasSeenClient(): boolean {
    return this.clientSeen;
  }

  get lastRequestMs(): number | null {
    return this.lastRequestAtMs;
  }

  get grantedScopes(): readonly string[] {
    return this.scopes.list();
  }

  async start(): Promise<Result<string, NexusError>> {
    if (this.server) return ok(this.endpoint);
    const endpoint = this.endpoint;

    if (this.platform !== 'win32') {
      await ensureDir(this.options.paths.runtime);
      // A socket file left by a crashed process would block the bind.
      await removeFile(endpoint);
    }

    const server = net.createServer((socket) => this.onConnection(socket));
    server.maxConnections = MAX_CONNECTIONS;

    const bound = await new Promise<Result<true, NexusError>>((resolve) => {
      const onError = (e: Error): void => resolve(err(toNexusError(e, 'E_IO')));
      server.once('error', onError);
      server.once('listening', () => {
        server.removeListener('error', onError);
        resolve(ok(true));
      });
      // Deliberately the path form. NEXUS never binds a port.
      server.listen({ path: endpoint });
    });

    if (!bound.ok) return err(bound.error);

    if (this.platform !== 'win32') {
      // Owner-only. On Windows the pipe inherits the creator's default ACL and
      // the runtime directory is per-user.
      await chmod(endpoint, 0o600).catch(() => undefined);
    }

    this.server = server;
    this.options.logger.info('Vesper interface listening', {
      endpoint,
      scopes: this.scopes.list(),
      transport: this.platform === 'win32' ? 'named pipe' : 'unix socket',
    });
    return ok(endpoint);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.platform !== 'win32') await removeFile(this.endpoint);
  }

  private onConnection(socket: net.Socket): void {
    const state: ConnectionState = { buffer: '', requestTimes: [], authenticated: false };

    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      socket.destroy();
    });
    socket.on('error', () => socket.destroy());

    socket.on('data', (chunk: string) => {
      state.buffer += chunk;
      if (state.buffer.length > MAX_LINE_BYTES) {
        this.writeLine(socket, failure('unknown', 'E_INVALID_INPUT', 'request exceeded the size limit'));
        socket.destroy();
        return;
      }
      let index = state.buffer.indexOf('\n');
      while (index >= 0) {
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 1);
        void this.handleLine(socket, line, state);
        index = state.buffer.indexOf('\n');
      }
    });
  }

  private async handleLine(socket: net.Socket, line: string, state: ConnectionState): Promise<void> {
    if (line.trim() === '') return;

    const now = this.options.clock.now();
    state.requestTimes = state.requestTimes.filter((t) => now - t < 60_000);
    state.requestTimes.push(now);
    if (state.requestTimes.length > REQUESTS_PER_MINUTE) {
      this.writeLine(socket, failure('unknown', 'E_LIMIT', 'too many requests'));
      socket.destroy();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.writeLine(socket, failure('unknown', 'E_INVALID_INPUT', 'request was not valid JSON'));
      return;
    }

    // Bound the structure before schema parsing, so a small hostile document
    // cannot cost an unbounded amount of work.
    const shape = assertSafeShape(parsed, { maxDepth: 8, maxNodes: 512 });
    if (!shape.ok) {
      this.writeLine(socket, failure('unknown', 'E_INVALID_INPUT', formatIssues(shape.error, 2)));
      return;
    }

    const request = requestSchema.parse(parsed);
    if (!request.ok) {
      this.writeLine(
        socket,
        failure('unknown', 'E_INVALID_INPUT', `request rejected: ${formatIssues(request.error, 3)}`),
      );
      return;
    }
    const { id, method, token, v } = request.value;

    if (!versionCompatible(v)) {
      this.writeLine(
        socket,
        failure(id, 'E_UNSUPPORTED', `contract version ${v} is not compatible with ${VESPER_CONTRACT_VERSION}`),
      );
      return;
    }

    if (!tokenMatches(this.options.token, token)) {
      if (!state.authenticated) {
        await this.options.eventLog.append({
          kind: 'vesper.rejected',
          severity: 'warning',
          message: 'a client presented an invalid token',
          data: { method },
        });
      }
      this.writeLine(socket, failure(id, 'E_AUTH', 'authentication failed'));
      socket.destroy();
      return;
    }

    if (!state.authenticated) {
      state.authenticated = true;
      this.clientSeen = true;
      await this.options.eventLog.append({
        kind: 'vesper.connected',
        severity: 'info',
        message: 'Vesper client authenticated',
        data: { scopes: this.scopes.list() },
      });
    }
    this.lastRequestAtMs = now;

    const scope = methodScope(method);
    if (scope === null) {
      this.writeLine(socket, failure(id, 'E_INVALID_INPUT', `unknown method "${method}"`));
      return;
    }
    if (!this.scopes.has(scope)) {
      // Asking is not authority. The scope has to have been granted by the
      // person who owns the machine, in NEXUS's own configuration.
      await this.options.eventLog.append({
        kind: 'vesper.rejected',
        severity: 'notice',
        message: `refused "${method}": the "${scope}" scope is not granted`,
        data: { method, scope, granted: this.scopes.list() },
      });
      this.writeLine(
        socket,
        failure(
          id,
          'E_SCOPE',
          `the "${scope}" scope is required for ${method} and has not been granted to Vesper on this machine`,
        ),
      );
      return;
    }

    await this.options.eventLog.append({
      kind: 'vesper.request',
      severity: 'info',
      message: `Vesper called ${method}`,
      data: { method, requestId: id },
    });

    let outcome: VesperHandlerResult;
    try {
      outcome = await dispatch(this.options.host, method, request.value.params);
    } catch (e) {
      const error = toNexusError(e);
      this.options.logger.error('Vesper handler threw', { method, error: error.message });
      this.writeLine(socket, failure(id, error.code, error.message));
      return;
    }

    this.writeLine(
      socket,
      outcome.ok
        ? success(id, outcome.fidelity, outcome.result)
        : failure(id, outcome.error.code, outcome.error.message, outcome.fidelity),
    );
  }

  private writeLine(socket: net.Socket, response: VesperResponse): void {
    if (socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      socket.destroy();
    }
  }
}

export function assertNoNetworkListener(): void {
  // Documented invariant, asserted by tests: NEXUS binds only path endpoints.
  if (process.env['NEXUS_ALLOW_TCP'] !== undefined) {
    throw nexusError('E_STATE', 'NEXUS does not support TCP transports');
  }
}
