/**
 * Filesystem layout.
 *
 * NEXUS keeps everything under a single home directory so that state,
 * evidence and recovery artifacts can be inspected, backed up or removed as a
 * unit. The location is per-user by default; nothing here requires elevation.
 *
 *   Windows  %LOCALAPPDATA%\NEXUS
 *   POSIX    $XDG_STATE_HOME/nexus  (or ~/.local/state/nexus)
 *   Override $NEXUS_HOME
 */

import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface NexusPaths {
  readonly home: string;
  /** Durable runtime state: session records, restart guard, last known good. */
  readonly state: string;
  /** Append-only audit event log segments. */
  readonly events: string;
  /** Short-term pre-change recovery records. */
  readonly checkpoints: string;
  /** Longer-term recovery artifacts. Distinct from checkpoints. */
  readonly backups: string;
  /** Captured hardware/performance baselines. */
  readonly baselines: string;
  /** User-authored profile documents. */
  readonly profiles: string;
  /** Diagnostic logs (not the audit trail). */
  readonly logs: string;
  /** Volatile per-boot files: instance lock, IPC endpoint metadata. */
  readonly runtime: string;
  /** Captured hardware discovery reports. */
  readonly discovery: string;
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env['NEXUS_HOME'];
  if (override && override.trim() !== '') {
    // Respect the explicit platform argument so callers/tests are deterministic
    // even when they emulate another OS on the host running Node.
    const resolver = platform === 'win32' ? path.win32 : path.posix;
    return resolver.resolve(override);
  }

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData && localAppData.trim() !== '') return path.join(localAppData, 'NEXUS');
    return path.join(homedir(), 'AppData', 'Local', 'NEXUS');
  }

  const xdgState = env['XDG_STATE_HOME'];
  if (xdgState && xdgState.trim() !== '') return path.join(xdgState, 'nexus');
  return path.join(homedir(), '.local', 'state', 'nexus');
}

export function resolvePaths(home: string = defaultHome()): NexusPaths {
  const root = path.resolve(home);
  return Object.freeze({
    home: root,
    state: path.join(root, 'state'),
    events: path.join(root, 'events'),
    checkpoints: path.join(root, 'checkpoints'),
    backups: path.join(root, 'backups'),
    baselines: path.join(root, 'baselines'),
    profiles: path.join(root, 'profiles'),
    logs: path.join(root, 'logs'),
    runtime: path.join(root, 'runtime'),
    discovery: path.join(root, 'discovery'),
  });
}

export function allDirectories(paths: NexusPaths): string[] {
  return [
    paths.home,
    paths.state,
    paths.events,
    paths.checkpoints,
    paths.backups,
    paths.baselines,
    paths.profiles,
    paths.logs,
    paths.runtime,
    paths.discovery,
  ];
}

/**
 * Local IPC endpoint for the Vesper interface.
 *
 * Windows: a named pipe. Named pipes are reachable over SMB only when opened
 * on a remote server path (\\host\pipe\name); a pipe created and consumed as
 * \\.\pipe\name is local to this machine.
 *
 * POSIX: a unix domain socket inside the runtime directory, created with
 * restrictive permissions.
 *
 * Neither is a network listener. NEXUS never binds a TCP or UDP port.
 */
/** Token-bound Windows endpoint. The secret prevents pre-binding a predictable pipe name. */
export function ipcEndpointForToken(
  paths: NexusPaths,
  token: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return ipcEndpoint(paths, platform);
  if (token.length < 32) throw new Error('NEXUS IPC token is too short to derive a secure endpoint');
  const digest = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\nexus-${digest}`;
}

export function ipcEndpoint(paths: NexusPaths, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\nexus-${endpointDiscriminator(paths.home)}`;
  }
  return path.join(paths.runtime, 'vesper.sock');
}

/**
 * Short, stable, non-secret discriminator derived from the home path so that
 * two NEXUS homes on one machine (e.g. a test home and the real one) do not
 * collide on the same pipe name.
 */
export function endpointDiscriminator(home: string): string {
  let h = 0x811c9dc5;
  const normalized = process.platform === 'win32' ? home.toLowerCase() : home;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Scratch directory for staged writes. Kept inside the home when possible. */
export function scratchDir(paths: NexusPaths): string {
  return path.join(paths.runtime, 'scratch');
}

export function systemTempDir(): string {
  return tmpdir();
}
