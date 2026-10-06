import type { CommandRunner } from '../core/exec.js';
import { parsePowerShellJson, runPowerShell } from '../core/exec.js';
import { nexusError, type NexusError } from '../core/errors.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/result.js';

export interface OpenXrRuntimeIdentity {
  readonly active: boolean;
  readonly manifestPath: string | null;
  readonly name: string | null;
  readonly manifestExists: boolean;
  readonly source: 'registry' | 'environment' | 'unavailable';
  readonly fidelity: 'live';
}

const SCRIPT = [
  '$paths = @()',
  `$hkcu = Get-ItemProperty -Path 'Registry::HKEY_CURRENT_USER\\Software\\Khronos\\OpenXR\\1' -Name ActiveRuntime -ErrorAction SilentlyContinue`,
  `$hklm = Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Khronos\\OpenXR\\1' -Name ActiveRuntime -ErrorAction SilentlyContinue`,
  'if ($hkcu -and $hkcu.ActiveRuntime) { $paths += [string]$hkcu.ActiveRuntime }',
  'if ($hklm -and $hklm.ActiveRuntime) { $paths += [string]$hklm.ActiveRuntime }',
  '$path = $paths | Select-Object -First 1',
  '$exists = $false',
  '$name = $null',
  'if ($path) { $exists = Test-Path -LiteralPath $path; if ($exists) { try { $m = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json; if ($m.runtime.name) { $name = [string]$m.runtime.name } } catch {} } }',
  `[pscustomobject]@{ active = [bool]$path; manifestPath = if ($path) { [string]$path } else { $null }; name = $name; manifestExists = [bool]$exists; source = if ($hkcu -and $path -eq [string]$hkcu.ActiveRuntime) { 'registry' } elseif ($hklm -and $path -eq [string]$hklm.ActiveRuntime) { 'registry' } else { 'unavailable' } } | ConvertTo-Json -Compress`,
].join('; ');

export async function readOpenXrRuntime(runner: CommandRunner): Promise<Result<OpenXrRuntimeIdentity, NexusError>> {
  const result = await runPowerShell(runner, SCRIPT, { timeoutMs: 10_000 });
  if (!result.ok) return err(result.error);
  if (result.value.timedOut) return err(nexusError('E_TIMEOUT', 'OpenXR runtime probe timed out'));
  if (result.value.code !== 0) return err(nexusError('E_UNAVAILABLE', result.value.stderr.trim() || 'OpenXR runtime probe failed'));
  const parsed = parsePowerShellJson(result.value.stdout);
  if (!parsed.ok) return err(parsed.error);
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return err(nexusError('E_IO', 'OpenXR runtime probe returned invalid JSON'));
  const row = parsed.value as Record<string, unknown>;
  const path = typeof row.manifestPath === 'string' && row.manifestPath.trim() ? row.manifestPath.trim() : null;
  return ok({
    active: row.active === true && path !== null,
    manifestPath: path,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
    manifestExists: row.manifestExists === true,
    source: row.source === 'registry' ? 'registry' : 'unavailable',
    fidelity: 'live',
  });
}
