/**
 * Process execution boundary.
 *
 * Everything NEXUS learns from the operating system that is not available
 * through a Node API comes through here. Three rules make this safe:
 *
 *  1. No shell. Commands are spawned with an argument vector, never a command
 *     string, so there is no quoting or interpolation to get wrong.
 *  2. An allowlist. Only the specific executables NEXUS is designed to call
 *     can be launched, by basename. A control, config file or Vesper request
 *     cannot cause an arbitrary program to run.
 *  3. Bounds. Every call has a timeout and an output cap, and the child is
 *     killed when either is exceeded.
 *
 * Dynamic values are never concatenated into a script. They are passed through
 * the child's environment and read there, so a value containing quotes,
 * semicolons or newlines is inert.
 */

import { spawn } from 'node:child_process';

import type { Result } from './result.js';
import { err, ok } from './result.js';
import type { NexusError } from './errors.js';
import { nexusError, toNexusError } from './errors.js';

/**
 * Executables NEXUS is permitted to launch, by lowercase basename without
 * extension. Adding to this list is a deliberate, reviewable act.
 */
/*
 * `wmic.exe` is deliberately absent: Microsoft removed it entirely in Windows
 * 11 24H2, so anything built on it breaks on current Windows. All CIM access
 * goes through PowerShell's Get-CimInstance.
 */
export const ALLOWED_EXECUTABLES: readonly string[] = Object.freeze([
  // Windows
  'powershell',
  'pwsh',
  'powercfg',
  'reg',
  'schtasks',
  'sc',
  'tasklist',
  // Mature frame telemetry collector (installed separately; NEXUS only invokes it).
  'presentmon',
  // Optional Microsoft Sysinternals topology probe; observation only.
  'coreinfo',
  // Small signed/native Windows bridge; stdin is JSON and the command set is fixed.
  'nexus-native-helper',
  // POSIX (development host only)
  'uname',
  'lscpu',
  'free',
  'nproc',
]);

const ALLOWED = new Set(ALLOWED_EXECUTABLES);

export interface CommandRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Extra environment for the child. Merged onto a minimal inherited set. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional bounded stdin payload for allowlisted helper processes. */
  readonly stdin?: string;
}

export interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<Result<CommandResult, NexusError>>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * Extract the executable name from a path.
 *
 * Both separators are handled explicitly rather than relying on
 * `path.basename`, which ignores backslashes on POSIX. Without this the
 * allowlist would behave differently depending on the host it runs on, which
 * is exactly the kind of platform-dependent security check that quietly
 * stops working.
 */
export function executableBasename(file: string): string {
  const base = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

export function isAllowedExecutable(file: string): boolean {
  return ALLOWED.has(executableBasename(file));
}

export class NodeCommandRunner implements CommandRunner {
  async run(request: CommandRequest): Promise<Result<CommandResult, NexusError>> {
    if (!isAllowedExecutable(request.file)) {
      return err(
        nexusError('E_INVALID_INPUT', `executable is not on the NEXUS allowlist: ${request.file}`, {
          file: request.file,
        }),
      );
    }
    for (const arg of request.args) {
      if (typeof arg !== 'string') {
        return err(nexusError('E_INVALID_INPUT', 'command arguments must be strings'));
      }
      if (arg.includes('\0')) {
        return err(nexusError('E_INVALID_INPUT', 'command arguments must not contain NUL'));
      }
    }

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutput = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const startedAt = Date.now();

    return new Promise<Result<CommandResult, NexusError>>((resolve) => {
      let child;
      try {
        child = spawn(request.file, [...request.args], {
          // Never `shell: true`.
          shell: false,
          windowsHide: true,
          stdio: [request.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env: buildChildEnv(request.env),
        });
      } catch (e) {
        resolve(err(toNexusError(e, 'E_IO')));
        return;
      }

      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();

      const capture = (chunk: Buffer, target: 'out' | 'err'): void => {
        if (truncated) return;
        bytes += chunk.length;
        if (bytes > maxOutput) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        if (target === 'out') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };

      if (request.stdin !== undefined) child.stdin?.end(request.stdin);

      child.stdout?.on('data', (c: Buffer) => capture(c, 'out'));
      child.stderr?.on('data', (c: Buffer) => capture(c, 'err'));

      const finish = (result: Result<CommandResult, NexusError>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      child.on('error', (e) => {
        finish(err(toNexusError(e, 'E_UNAVAILABLE')));
      });

      child.on('close', (code, signal) => {
        finish(
          ok({
            code,
            signal,
            stdout,
            stderr,
            timedOut,
            truncated,
            durationMs: Date.now() - startedAt,
          }),
        );
      });
    });
  }
}

/**
 * A minimal environment for children. Inheriting the full parent environment
 * would leak whatever the user has in it into subprocess output and crash
 * dumps for no benefit.
 */
function buildChildEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const keep = [
    'SystemRoot',
    'windir',
    'SystemDrive',
    'PATH',
    'Path',
    'PATHEXT',
    'TEMP',
    'TMP',
    'ComSpec',
    'PSModulePath',
    'HOME',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (!/^NEXUS_ARG_[A-Z0-9_]{1,32}$/.test(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/* ------------------------------------------------------------- PowerShell */

export interface PowerShellOptions {
  readonly timeoutMs?: number;
  /**
   * Values made available to the script as `$env:NEXUS_ARG_<NAME>`. Passing
   * them this way keeps user- and hardware-derived strings out of the script
   * text entirely.
   */
  readonly args?: Readonly<Record<string, string>>;
  readonly executable?: string;
}

/**
 * Run a PowerShell script that NEXUS itself authored.
 *
 * `-NoProfile` keeps a user profile from changing behaviour, and
 * `-NonInteractive` guarantees the child can never block waiting for input.
 */
export async function runPowerShell(
  runner: CommandRunner,
  script: string,
  options: PowerShellOptions = {},
): Promise<Result<CommandResult, NexusError>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.args ?? {})) {
    env[`NEXUS_ARG_${name.toUpperCase()}`] = value;
  }
  const request: CommandRequest = {
    file: options.executable ?? 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-OutputFormat',
      'Text',
      '-Command',
      script,
    ],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
  return runner.run(request);
}

/** Parse JSON emitted by a PowerShell script, tolerating a BOM and blank output. */
export function parsePowerShellJson(stdout: string): Result<unknown, NexusError> {
  const trimmed = stdout.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') return err(nexusError('E_UNAVAILABLE', 'command produced no output'));
  try {
    return ok(JSON.parse(trimmed));
  } catch (e) {
    return err(nexusError('E_IO', 'command output was not valid JSON', undefined, e));
  }
}

/* ------------------------------------------------------------------ tests */

export interface ScriptedResponse {
  readonly match: (request: CommandRequest) => boolean;
  readonly result: Result<CommandResult, NexusError>;
}

/** Deterministic runner for tests. Records every request it received. */
export class ScriptedCommandRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  private readonly responses: ScriptedResponse[];

  constructor(responses: ScriptedResponse[] = []) {
    this.responses = responses;
  }

  async run(request: CommandRequest): Promise<Result<CommandResult, NexusError>> {
    this.requests.push(request);
    if (!isAllowedExecutable(request.file)) {
      return err(nexusError('E_INVALID_INPUT', `executable is not on the NEXUS allowlist: ${request.file}`));
    }
    for (const response of this.responses) {
      if (response.match(request)) return response.result;
    }
    return err(nexusError('E_UNAVAILABLE', `no scripted response for ${request.file}`));
  }
}

export function commandOk(stdout: string, overrides: Partial<CommandResult> = {}): Result<CommandResult, NexusError> {
  return ok({
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    truncated: false,
    durationMs: 1,
    ...overrides,
  });
}
