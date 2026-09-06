/**
 * Foreground / active-window detection.
 *
 * Process enumeration lists what is running. Foreground detection answers which
 * of those processes owns the focused window — useful corroboration when a game
 * is open in the background while the user is in a browser.
 *
 * Honesty rules:
 *   - Windows: Win32 GetForegroundWindow via a fixed PowerShell script through
 *     the allowlisted exec boundary. Never verified against a real Windows host
 *     from this repository; the capability probe is what keeps a wrong
 *     assumption from becoming a wrong action.
 *   - Elsewhere: unsupported. isForeground stays null; the classifier does not
 *     treat null as false.
 *   - A failed or unsupported detection never invents a foreground process and
 *     never fails process enumeration.
 */

import type { CommandRunner } from '../core/exec.js';
import { parsePowerShellJson, runPowerShell } from '../core/exec.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import type { Fidelity } from '../core/fidelity.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { isPlainObject } from '../core/validate.js';
import type { ProcessObservation } from '../domain/workload.js';

export interface ForegroundProcess {
  readonly pid: number;
  /** Image name when known (often with .exe on Windows). Null if only the pid is known. */
  readonly name: string | null;
}

export interface ForegroundDetection {
  /** Null when the detector worked but there is no foreground window. */
  readonly foreground: ForegroundProcess | null;
  readonly fidelity: Fidelity;
  readonly backend: string;
  readonly detectedAtMs: number;
}

export interface ForegroundDetector {
  readonly id: string;
  readonly trust: Fidelity;
  detect(): Promise<Result<ForegroundDetection, NexusError>>;
}

export interface ForegroundDetectorFactoryOptions {
  readonly platform: NodeJS.Platform;
  readonly runner: CommandRunner;
  readonly clock: { now(): number };
}

/**
 * Fixed script. Dynamic values are never interpolated — the script only reads
 * Win32 state and emits JSON.
 */
export const WINDOWS_FOREGROUND_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NexusFgWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$hwnd = [NexusFgWin32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  [pscustomobject]@{ pid = $null; name = $null } | ConvertTo-Json -Compress
  exit 0
}

$fgPid = [uint32]0
[void][NexusFgWin32]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)

$name = $null
try {
  $proc = Get-Process -Id $fgPid -ErrorAction Stop
  # ProcessName lacks an extension; tasklist image names usually include .exe.
  $name = $proc.ProcessName + '.exe'
} catch {
  $name = $null
}

[pscustomobject]@{ pid = [int64]$fgPid; name = $name } | ConvertTo-Json -Compress
`;

export function createForegroundDetector(options: ForegroundDetectorFactoryOptions): ForegroundDetector {
  if (options.platform === 'win32') {
    return new WindowsForegroundDetector(options.runner, options.clock);
  }
  return new UnsupportedForegroundDetector(options.platform, options.clock);
}

export class WindowsForegroundDetector implements ForegroundDetector {
  readonly id = 'windows.user32.foreground';
  readonly trust = 'live' as const;

  private readonly runner: CommandRunner;
  private readonly clock: { now(): number };

  constructor(runner: CommandRunner, clock: { now(): number }) {
    this.runner = runner;
    this.clock = clock;
  }

  async detect(): Promise<Result<ForegroundDetection, NexusError>> {
    const response = await runPowerShell(this.runner, WINDOWS_FOREGROUND_SCRIPT, {
      timeoutMs: 5_000,
    });
    if (!response.ok) return err(response.error);
    if (response.value.timedOut) {
      return err(nexusError('E_TIMEOUT', 'foreground detection timed out'));
    }
    if (response.value.code !== 0) {
      return err(
        nexusError('E_UNAVAILABLE', `foreground detection exited with code ${response.value.code}`, {
          stderr: response.value.stderr.slice(0, 500),
        }),
      );
    }

    const parsed = parseForegroundPayload(response.value.stdout);
    if (!parsed.ok) return err(parsed.error);

    return ok({
      foreground: parsed.value,
      fidelity: 'live',
      backend: this.id,
      detectedAtMs: this.clock.now(),
    });
  }
}

export class UnsupportedForegroundDetector implements ForegroundDetector {
  readonly id = 'process.foreground.unsupported';
  readonly trust = 'unavailable' as const;

  private readonly platform: string;
  private readonly clock: { now(): number };

  constructor(platform: string, clock: { now(): number }) {
    this.platform = platform;
    this.clock = clock;
  }

  async detect(): Promise<Result<ForegroundDetection, NexusError>> {
    void this.clock;
    return err(
      nexusError(
        'E_UNSUPPORTED',
        `foreground detection is not supported on platform "${this.platform}"`,
      ),
    );
  }
}

/** Parse the JSON object emitted by WINDOWS_FOREGROUND_SCRIPT. */
export function parseForegroundPayload(stdout: string): Result<ForegroundProcess | null, NexusError> {
  const parsed = parsePowerShellJson(stdout);
  if (!parsed.ok) return err(parsed.error);
  if (!isPlainObject(parsed.value)) {
    return err(nexusError('E_IO', 'foreground detection output was not an object'));
  }
  const pidRaw = parsed.value['pid'];
  const nameRaw = parsed.value['name'];

  if (pidRaw === null || pidRaw === undefined) {
    return ok(null);
  }
  if (typeof pidRaw !== 'number' || !Number.isSafeInteger(pidRaw) || pidRaw < 0) {
    return err(nexusError('E_IO', `foreground detection reported an invalid pid: ${String(pidRaw)}`));
  }
  let name: string | null = null;
  if (typeof nameRaw === 'string' && nameRaw.trim() !== '') {
    name = nameRaw.trim();
  } else if (nameRaw !== null && nameRaw !== undefined) {
    return err(nexusError('E_IO', 'foreground detection reported a non-string name'));
  }
  return ok({ pid: pidRaw, name });
}

/**
 * Mark processes whose pid matches the foreground pid. Processes not in the
 * sample stay unmarked (we do not invent rows). When foreground is null, every
 * observation stays null — "no window" is not the same as "not foreground".
 */
export function annotateWithForeground(
  processes: readonly ProcessObservation[],
  foreground: ForegroundProcess | null,
): ProcessObservation[] {
  if (foreground === null) {
    return processes.map((p) => ({ ...p, isForeground: null }));
  }
  return processes.map((p) => ({
    ...p,
    isForeground: p.pid !== null && p.pid === foreground.pid,
  }));
}

export async function probeForegroundDetection(
  detector: ForegroundDetector,
): Promise<{ state: 'available' | 'unavailable' | 'unsupported'; detail: string; fidelity?: Fidelity }> {
  const result = await detector.detect();
  if (!result.ok) {
    if (result.error.code === 'E_UNSUPPORTED') {
      return { state: 'unsupported', detail: result.error.message };
    }
    return { state: 'unavailable', detail: result.error.message };
  }
  const fg = result.value.foreground;
  const detail =
    fg === null
      ? `${result.value.backend} responded (no foreground window)`
      : `${result.value.backend} reported pid=${fg.pid}${fg.name ? ` name="${fg.name}"` : ''}`;
  return {
    state: result.value.fidelity === 'live' ? 'available' : 'unavailable',
    fidelity: result.value.fidelity,
    detail,
  };
}
