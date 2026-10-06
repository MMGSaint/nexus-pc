import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StabilityEvent {
  readonly provider: string;
  readonly eventId: number;
  readonly timeCreated: string | null;
  readonly message: string;
}

export interface StabilitySnapshot {
  readonly capturedAt: string;
  readonly whea: readonly StabilityEvent[];
  readonly displayTdr: readonly StabilityEvent[];
  readonly stable: boolean;
  readonly source: 'windows-event-log';
}

export async function readWindowsStability(
  sinceIso: string,
  powershell = 'powershell.exe',
): Promise<StabilitySnapshot> {
  const script =
    '$ErrorActionPreference="Stop"; $since=[DateTime]::Parse($args[0]).ToUniversalTime(); ' +
    '$e=Get-WinEvent -FilterHashtable @{LogName="System";StartTime=$since;Id=1,41,1001,4101} ' +
    '-ErrorAction SilentlyContinue; $e | % {[PSCustomObject]@{Provider=$_.ProviderName;Id=$_.Id;' +
    'Time=$_.TimeCreated.ToUniversalTime().ToString("o");Message=$_.Message}} | ConvertTo-Json ' +
    '-Compress -Depth 3';
  const { stdout } = await execFileAsync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, sinceIso],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const raw = stdout.trim();
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const events: StabilityEvent[] = rows
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const r = x as Record<string, unknown>;
      return {
        provider: typeof r.Provider === 'string' ? r.Provider : 'unknown',
        eventId: Number(r.Id),
        timeCreated: typeof r.Time === 'string' ? r.Time : null,
        message: typeof r.Message === 'string' ? r.Message.slice(0, 2000) : '',
      };
    });
  const whea = events.filter((e) => e.provider === 'WHEA-Logger');
  const displayTdr = events.filter((e) => e.eventId === 4101 && e.provider === 'Display');
  return {
    capturedAt: new Date().toISOString(),
    whea,
    displayTdr,
    stable: whea.length === 0 && displayTdr.length === 0,
    source: 'windows-event-log',
  };
}
