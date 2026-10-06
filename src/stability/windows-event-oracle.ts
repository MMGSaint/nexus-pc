/**
 * Windows stability oracle.
 *
 * Uses the built-in Windows Event Log instead of inventing another monitor.
 * The oracle is intentionally observational: it cannot edit logs or suppress
 * events. A post-change delta is adverse evidence suitable for automatic rollback.
 */

import type { CommandRunner } from '../core/exec.js';
import { nexusError, type NexusError } from '../core/errors.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import { runPowerShell, parsePowerShellJson } from '../core/exec.js';

export interface StabilitySnapshot {
  readonly capturedAtMs: number;
  readonly available: boolean;
  readonly whea: number;
  readonly displayTdr: number;
  readonly appCrashes: number;
  readonly werEvents: number;
  readonly totalErrors: number;
  readonly detail: string;
}

export interface StabilityDelta {
  readonly whea: number;
  readonly displayTdr: number;
  readonly appCrashes: number;
  readonly werEvents: number;
  readonly totalErrors: number;
  readonly unstable: boolean;
}

const SCRIPT = String.raw`
$since = try { [DateTime]::Parse($env:NEXUS_ARG_SINCE) } catch { (Get-Date).AddMinutes(-5) }
$systemWhea = @(Get-WinEvent -FilterHashtable @{ LogName='System'; ProviderName='WHEA-Logger'; StartTime=$since } -ErrorAction SilentlyContinue).Count
$displayTdr = @(Get-WinEvent -FilterHashtable @{ LogName='System'; Id=4101; StartTime=$since } -ErrorAction SilentlyContinue).Count
$appCrashes = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; Id=1000; StartTime=$since } -ErrorAction SilentlyContinue).Count
$werEvents = @(Get-WinEvent -FilterHashtable @{ LogName='Application'; Id=1001; StartTime=$since } -ErrorAction SilentlyContinue).Count
[pscustomobject]@{
  whea = [int]$systemWhea
  displayTdr = [int]$displayTdr
  appCrashes = [int]$appCrashes
  werEvents = [int]$werEvents
} | ConvertTo-Json -Compress
`;

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export async function captureWindowsStability(
  runner: CommandRunner,
  sinceMs: number,
  nowMs = Date.now(),
): Promise<Result<StabilitySnapshot, NexusError>> {
  if (!Number.isFinite(sinceMs)) {
    return err(nexusError('E_INVALID_INPUT', 'stability oracle requires a finite start timestamp'));
  }
  const result = await runPowerShell(runner, SCRIPT, {
    timeoutMs: 15_000,
    args: { since: new Date(sinceMs).toISOString() },
  });
  if (!result.ok) return err(result.error);
  const parsed = parsePowerShellJson(result.value.stdout);
  if (!parsed.ok) return err(parsed.error);
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return err(nexusError('E_IO', 'stability oracle returned an invalid JSON object'));
  }
  const obj = parsed.value as Record<string, unknown>;
  const whea = nonNegative(obj.whea);
  const displayTdr = nonNegative(obj.displayTdr);
  const appCrashes = nonNegative(obj.appCrashes);
  const werEvents = nonNegative(obj.werEvents);
  return ok({
    capturedAtMs: nowMs,
    available: true,
    whea,
    displayTdr,
    appCrashes,
    werEvents,
    totalErrors: whea + displayTdr + appCrashes,
    detail: 'Windows Event Log query completed.',
  });
}

export function diffWindowsStability(
  before: StabilitySnapshot,
  after: StabilitySnapshot,
): StabilityDelta {
  const delta = {
    whea: Math.max(0, after.whea - before.whea),
    displayTdr: Math.max(0, after.displayTdr - before.displayTdr),
    appCrashes: Math.max(0, after.appCrashes - before.appCrashes),
    werEvents: Math.max(0, after.werEvents - before.werEvents),
  };
  return {
    ...delta,
    totalErrors: delta.whea + delta.displayTdr + delta.appCrashes,
    unstable: delta.whea > 0 || delta.displayTdr > 0 || delta.appCrashes > 0,
  };
}
