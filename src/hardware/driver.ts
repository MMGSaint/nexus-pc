import type { CommandRunner } from '../core/exec.js';
import { parsePowerShellJson, runPowerShell } from '../core/exec.js';
import { nexusError, type NexusError } from '../core/errors.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/result.js';

export interface DisplayDriverIdentity {
  readonly version: string;
  readonly provider: string | null;
  readonly deviceName: string | null;
  readonly capturedAtMs: number;
  readonly fidelity: 'live';
}

const SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `$rows = @(Get-CimInstance Win32_PnPSignedDriver -Filter "DeviceClass = 'DISPLAY'" | Where-Object { $_.DriverVersion } | Sort-Object DriverProviderName, DeviceName)`,
  '$row = $rows | Select-Object -First 1 DriverVersion, DriverProviderName, DeviceName',
  `if ($null -eq $row) { throw 'No signed display driver was found.' }`,
  '[pscustomobject]@{ version = [string]$row.DriverVersion; provider = [string]$row.DriverProviderName; deviceName = [string]$row.DeviceName } | ConvertTo-Json -Compress',
].join('; ');

export async function readWindowsDisplayDriver(runner: CommandRunner, nowMs = Date.now()): Promise<Result<DisplayDriverIdentity, NexusError>> {
  const result = await runPowerShell(runner, SCRIPT, { timeoutMs: 15_000 });
  if (!result.ok) return err(result.error);
  if (result.value.timedOut) return err(nexusError('E_TIMEOUT', 'display driver detection timed out', undefined, undefined));
  if (result.value.code !== 0) return err(nexusError('E_UNAVAILABLE', result.value.stderr.trim() || 'display driver detection failed'));
  const parsed = parsePowerShellJson(result.value.stdout);
  if (!parsed.ok) return err(parsed.error);
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return err(nexusError('E_IO', 'display driver detection returned an invalid object'));
  const row = parsed.value as Record<string, unknown>;
  const version = typeof row.version === 'string' ? row.version.trim() : '';
  if (!version) return err(nexusError('E_IO', 'display driver detection returned no version'));
  return ok({ version, provider: typeof row.provider === 'string' && row.provider.trim() ? row.provider.trim() : null, deviceName: typeof row.deviceName === 'string' && row.deviceName.trim() ? row.deviceName.trim() : null, capturedAtMs: nowMs, fidelity: 'live' });
}
