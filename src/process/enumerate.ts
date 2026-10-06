/**
 * Process enumeration.
 *
 * Workload classification can use process names as corroborating heuristics.
 * Those names only exist if this module can actually list processes on the
 * machine. Writing the classifier did not create that ability — a successful
 * probe does.
 *
 * Backends:
 *   - Linux: read /proc directly (pid, comm, optional RSS). No shell.
 *   - Windows: `tasklist.exe /FO CSV /NH` through the allowlisted exec
 *     boundary. No shell strings; arguments are a fixed vector.
 *
 * Foreground detection and priority control are deliberately out of scope
 * here. `isForeground` and `cpuPercent` are reported as null until those
 * capabilities exist.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { CommandRunner } from '../core/exec.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import type { Fidelity } from '../core/fidelity.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import type { ProcessObservation } from '../domain/workload.js';
import { getForegroundProcess, type NativeWindowsHelperOptions } from './windows-native.js';

/** Soft ceiling so a pathological process table cannot flood the classifier. */
export const DEFAULT_MAX_PROCESSES = 512;

export interface ProcessEnumeration {
  readonly processes: readonly ProcessObservation[];
  readonly fidelity: Fidelity;
  readonly backend: string;
  readonly truncated: boolean;
  readonly enumeratedAtMs: number;
  /** How many process records were seen before the cap, when known. */
  readonly seen?: number;
}

export interface EnumerateOptions {
  readonly maxProcesses?: number;
}

export interface ProcessEnumerator {
  readonly id: string;
  readonly trust: Fidelity;
  enumerate(options?: EnumerateOptions): Promise<Result<ProcessEnumeration, NexusError>>;
}

export interface ProcessEnumeratorFactoryOptions {
  readonly platform: NodeJS.Platform;
  readonly runner: CommandRunner;
  readonly clock: Clock;
  /** Override /proc root — tests only. */
  readonly procRoot?: string;
  /** Trusted native helper configuration for Windows foreground evidence. */
  readonly nativeHelperOptions?: NativeWindowsHelperOptions;
}

export function createProcessEnumerator(options: ProcessEnumeratorFactoryOptions): ProcessEnumerator {
  if (options.platform === 'linux') {
    return new LinuxProcessEnumerator(options.clock, options.procRoot ?? '/proc');
  }
  if (options.platform === 'win32') {
    return new WindowsProcessEnumerator(options.runner, options.clock, options.nativeHelperOptions);
  }
  return new UnsupportedProcessEnumerator(options.platform, options.clock);
}

/* ----------------------------------------------------------------- Linux */

/**
 * Enumerate via /proc. Real readings of this host, so fidelity is `live`.
 * Used on the development host and any Linux deployment; not a Windows
 * substitute.
 */
export class LinuxProcessEnumerator implements ProcessEnumerator {
  readonly id = 'linux.procfs.processes';
  readonly trust = 'live' as const;

  private readonly clock: Clock;
  private readonly procRoot: string;

  constructor(clock: Clock, procRoot = '/proc') {
    this.clock = clock;
    this.procRoot = procRoot;
  }

  async enumerate(options: EnumerateOptions = {}): Promise<Result<ProcessEnumeration, NexusError>> {
    const max = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    let entries: string[];
    try {
      entries = await readdir(this.procRoot);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(nexusError('E_UNAVAILABLE', `/proc is not readable: ${message}`));
    }

    const collected: ProcessObservation[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const observation = await this.readOne(pid);
      if (observation) collected.push(observation);
    }

    if (collected.length === 0) {
      return err(
        nexusError(
          'E_UNAVAILABLE',
          `no process entries could be read under ${this.procRoot}`,
        ),
      );
    }

    const ranked = rankByWorkingSet(collected);
    const truncated = ranked.length > max;
    const processes = truncated ? ranked.slice(0, max) : ranked;

    return ok({
      processes,
      fidelity: 'live',
      backend: this.id,
      truncated,
      enumeratedAtMs: this.clock.now(),
      seen: ranked.length,
    });
  }

  private async readOne(pid: number): Promise<ProcessObservation | null> {
    const dir = path.join(this.procRoot, String(pid));
    let name: string;
    try {
      name = (await readFile(path.join(dir, 'comm'), 'utf8')).trim();
    } catch {
      return null;
    }
    if (name === '') name = `pid:${pid}`;

    let workingSetBytes: number | null = null;
    try {
      const status = await readFile(path.join(dir, 'status'), 'utf8');
      workingSetBytes = parseLinuxVmRss(status);
    } catch {
      // RSS is optional evidence; a missing status file is not a failure.
    }

    return {
      name,
      pid,
      cpuPercent: null,
      workingSetBytes,
      isForeground: null,
    };
  }
}

/** `VmRSS:` is reported in kB. Absent or unparseable → null. */
export function parseLinuxVmRss(statusText: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(statusText);
  if (!match?.[1]) return null;
  const kb = Number(match[1]);
  if (!Number.isFinite(kb) || kb < 0) return null;
  return kb * 1024;
}

/* --------------------------------------------------------------- Windows */

/**
 * Enumerate via allowlisted `tasklist`. Never verified against a real Windows
 * host from this repository — capability probing is what keeps a wrong
 * assumption from becoming a wrong action.
 */
export class WindowsProcessEnumerator implements ProcessEnumerator {
  readonly id = 'windows.tasklist';
  readonly trust = 'live' as const;

  private readonly runner: CommandRunner;
  private readonly clock: Clock;
  private readonly nativeHelperOptions?: NativeWindowsHelperOptions;

  constructor(runner: CommandRunner, clock: Clock, nativeHelperOptions?: NativeWindowsHelperOptions) {
    this.runner = runner;
    this.clock = clock;
    this.nativeHelperOptions = nativeHelperOptions;
  }

  async enumerate(options: EnumerateOptions = {}): Promise<Result<ProcessEnumeration, NexusError>> {
    const max = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    const result = await this.runner.run({
      file: 'tasklist.exe',
      // Fixed argument vector. Never interpolate, never shell.
      args: ['/FO', 'CSV', '/NH'],
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (!result.ok) return err(result.error);
    if (result.value.timedOut) {
      return err(nexusError('E_TIMEOUT', 'tasklist timed out'));
    }
    if (result.value.code !== 0) {
      return err(
        nexusError('E_UNAVAILABLE', `tasklist exited with code ${result.value.code}`, {
          stderr: result.value.stderr.slice(0, 500),
        }),
      );
    }

    const parsed = parseTasklistCsv(result.value.stdout);
    if (!parsed.ok) return err(parsed.error);
    if (parsed.value.length === 0) {
      return err(nexusError('E_UNAVAILABLE', 'tasklist produced no process rows'));
    }

    const foreground = await getForegroundProcess(this.runner, this.nativeHelperOptions).catch(() => null);
    const enriched = foreground?.ok && foreground.value.available && foreground.value.pid !== null
      ? parsed.value.map((process) => ({ ...process, isForeground: process.pid === foreground.value.pid }))
      : parsed.value;

    const ranked = rankByWorkingSet(enriched);
    const truncated = ranked.length > max;
    const processes = truncated ? ranked.slice(0, max) : ranked;

    return ok({
      processes,
      fidelity: 'live',
      backend: this.id,
      truncated,
      enumeratedAtMs: this.clock.now(),
      seen: ranked.length,
    });
  }
}

/**
 * Parse `tasklist /FO CSV /NH` output.
 *
 * Columns: Image Name, PID, Session Name, Session#, Mem Usage.
 * Mem Usage looks like `"12,345 K"` (locale thousands separators inside quotes).
 */
export function parseTasklistCsv(stdout: string): Result<ProcessObservation[], NexusError> {
  const lines = stdout.replace(/^\uFEFF/, '').split(/\r?\n/);
  const processes: ProcessObservation[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const fields = parseCsvLine(line);
    if (fields === null || fields.length < 5) {
      return err(
        nexusError('E_IO', 'tasklist CSV row could not be parsed', {
          row: line.slice(0, 120),
        }),
      );
    }
    const name = fields[0] ?? '';
    const pidRaw = fields[1] ?? '';
    const memRaw = fields[4] ?? '';
    if (name === '') {
      return err(nexusError('E_IO', 'tasklist CSV row is missing an image name'));
    }
    const pid = Number(pidRaw);
    if (!Number.isSafeInteger(pid) || pid < 0) {
      return err(nexusError('E_IO', `tasklist CSV row has an invalid PID: ${pidRaw}`));
    }
    processes.push({
      name,
      pid,
      cpuPercent: null,
      workingSetBytes: parseWindowsMemUsage(memRaw),
      isForeground: null,
    });
  }

  return ok(processes);
}

/** `"1,234 K"` / `"1234 K"` / `"1 234 K"` → bytes. Unparseable → null. */
export function parseWindowsMemUsage(raw: string): number | null {
  const cleaned = raw.replace(/[",]/g, '').trim();
  const match = /^([\d\s]+)\s*K$/i.exec(cleaned);
  if (!match?.[1]) return null;
  const kb = Number(match[1].replace(/\s+/g, ''));
  if (!Number.isFinite(kb) || kb < 0) return null;
  return kb * 1024;
}

/**
 * Minimal CSV line parser for tasklist's quoted fields. Returns null when the
 * line is not well-formed enough to trust.
 */
export function parseCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (inQuotes) return null;
  fields.push(current);
  return fields;
}

/* ----------------------------------------------------------- unsupported */

export class UnsupportedProcessEnumerator implements ProcessEnumerator {
  readonly id = 'process.unsupported';
  readonly trust = 'unavailable' as const;

  private readonly platform: string;
  private readonly clock: Clock;

  constructor(platform: string, clock: Clock) {
    this.platform = platform;
    this.clock = clock;
  }

  async enumerate(): Promise<Result<ProcessEnumeration, NexusError>> {
    void this.clock;
    return err(
      nexusError(
        'E_UNSUPPORTED',
        `process enumeration is not supported on platform "${this.platform}"`,
      ),
    );
  }
}

/* ---------------------------------------------------------------- helpers */

function rankByWorkingSet(processes: readonly ProcessObservation[]): ProcessObservation[] {
  return [...processes].sort((a, b) => {
    const aRss = a.workingSetBytes ?? -1;
    const bRss = b.workingSetBytes ?? -1;
    if (bRss !== aRss) return bRss - aRss;
    return (a.pid ?? 0) - (b.pid ?? 0);
  });
}

/**
 * Probe helper used by the capability registry. Success means enumeration
 * returned at least one process; anything else is unavailable/unsupported
 * with the underlying reason.
 */
export async function probeProcessEnumeration(
  enumerator: ProcessEnumerator,
): Promise<{ state: 'available' | 'unavailable' | 'unsupported'; detail: string; fidelity?: Fidelity }> {
  const result = await enumerator.enumerate({ maxProcesses: 16 });
  if (!result.ok) {
    if (result.error.code === 'E_UNSUPPORTED') {
      return { state: 'unsupported', detail: result.error.message };
    }
    return { state: 'unavailable', detail: result.error.message };
  }
  const sample = result.value.processes[0]?.name ?? 'unknown';
  const count = result.value.seen ?? result.value.processes.length;
  return {
    state: result.value.fidelity === 'live' ? 'available' : 'unavailable',
    fidelity: result.value.fidelity,
    detail: `${result.value.backend} listed ${count} process(es); sample="${sample}"`,
  };
}
