/**
 * Windows CPU and GPU utilisation.
 *
 * Sourced from the formatted performance-counter CIM classes rather than
 * `Get-Counter`, for two reasons: counter *paths* are localised (the English
 * path fails on a German or Japanese Windows) while the CIM property names are
 * not, and the formatted classes return a cooked value without the two-sample
 * dance a raw PDH query needs.
 *
 * `% Processor Utility` is preferred over `% Processor Time`. The latter
 * measures the fraction of time the CPU was non-idle and saturates at 100%, so
 * it cannot tell a 9950X pinned at 3 GHz from the same chip pinned at 5.7 GHz.
 * Utility normalises by frequency and legitimately reads above 100% under
 * boost; NEXUS records that value rather than clamping it, because the excess
 * is exactly the signal the counter exists to carry.
 *
 * STATUS: implemented, hardware dependent. The CIM class names and property
 * names below have not been executed against a Windows host in this
 * repository's test environment. Every one of them is behind a capability
 * probe, so an incorrect name degrades that metric to `unavailable` rather
 * than producing a wrong number.
 */

import type { Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import { PersistentShell } from '../../core/persistent-shell.js';
import { isPlainObject } from '../../core/validate.js';
import type { MetricId, Reading } from '../../domain/telemetry.js';
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export const WINDOWS_SENSOR_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Get-NexusTelemetry {
  $out = @{}

  # Processor Information (not the legacy Processor object): it is processor
  # group aware and it is the object that carries % Processor Utility.
  $p = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation |
       Where-Object { $_.Name -eq '_Total' -or $_.Name -like '*,_Total' } |
       Select-Object -First 1
  if ($p) {
    $out['cpuUtility']      = $p.PercentProcessorUtility
    $out['cpuTime']         = $p.PercentProcessorTime
    $out['cpuPerformance']  = $p.PercentProcessorPerformance
    $out['cpuFrequencyMhz'] = $p.ProcessorFrequency
  }

  $eng = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
         Where-Object { $_.Name -like '*engtype_3D*' }
  if ($eng) {
    $out['gpu3d'] = (($eng | Measure-Object -Property UtilizationPercentage -Sum).Sum)
  }

  $adapter = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory
  if ($adapter) {
    $out['gpuDedicatedBytes'] = (($adapter | Measure-Object -Property DedicatedUsage -Sum).Sum)
  }

  return $out
}

[Console]::Out.WriteLine('NEXUSREADY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'exit') { break }

  # Each request carries an id, echoed on the reply. Every path below answers
  # exactly once: a command that produced no line would desynchronise nothing
  # now, but it would still leave the caller waiting for its deadline.
  $parts = $line.Split(' ', 2)
  $id = $parts[0]
  $command = if ($parts.Length -gt 1) { $parts[1] } else { '' }

  $payload = $null
  try {
    if ($command -eq 'telemetry') { $payload = Get-NexusTelemetry }
    else { $payload = @{ error = 'unknown command' } }
  } catch {
    $payload = @{ error = $_.Exception.Message }
  }
  if ($null -eq $payload) { $payload = @{ error = 'no data' } }
  $json = ConvertTo-Json -InputObject $payload -Depth 4 -Compress
  [Console]::Out.WriteLine("NEXUSJSON $id $json")
}
`;

export interface WindowsTelemetryOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly shell?: PersistentShell;
}

export class WindowsTelemetrySource implements TelemetrySource {
  readonly id = 'windows.perfcounters';
  readonly trust = 'live' as const;
  readonly metrics: readonly MetricId[] = [
    'cpu.utilization',
    'cpu.clock',
    'gpu.utilization',
    'gpu.vram.used',
  ];

  private readonly shell: PersistentShell;

  constructor(options: WindowsTelemetryOptions) {
    this.shell =
      options.shell ??
      new PersistentShell({
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          WINDOWS_SENSOR_HOST_SCRIPT,
        ],
        clock: options.clock,
        logger: options.logger,
      });
  }

  async start(): Promise<void> {
    const started = await this.shell.start();
    if (!started.ok) throw started.error;
  }

  async stop(): Promise<void> {
    await this.shell.stop();
  }

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const nowMs = context.clock.now();
    const response = await this.shell.request('telemetry', context.timeoutMs);

    if (!response.ok) {
      return this.allUnknown(nowMs, 'unavailable', response.error.message);
    }
    if (!isPlainObject(response.value)) {
      return this.allUnknown(nowMs, 'invalid', 'sensor host returned a non-object payload');
    }
    const data = response.value;
    if (typeof data['error'] === 'string') {
      return this.allUnknown(nowMs, 'unavailable', String(data['error']).slice(0, 200));
    }

    const out: Reading[] = [];
    const emit = (metric: MetricId, value: unknown, note?: string): void => {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
      if (n === null) {
        out.push(
          unknownReading({
            metric,
            timestampMs: nowMs,
            source: this.id,
            status: 'unavailable',
            note: 'this counter is not present on this machine',
          }),
        );
        return;
      }
      out.push(
        reading({
          metric,
          value: n,
          timestampMs: nowMs,
          source: this.id,
          fidelity: 'live',
          ...(note === undefined ? {} : { note }),
        }),
      );
    };

    // Prefer Utility; fall back to Time only when Utility is absent, and say so.
    const utility = data['cpuUtility'];
    if (typeof utility === 'number' && Number.isFinite(utility)) {
      emit('cpu.utilization', utility, 'from % Processor Utility; may exceed 100% under boost');
    } else {
      emit(
        'cpu.utilization',
        data['cpuTime'],
        '% Processor Utility was unavailable; this is % Processor Time, which saturates at 100% and understates a boosting CPU',
      );
    }

    emit('cpu.clock', data['cpuFrequencyMhz']);
    emit('gpu.utilization', data['gpu3d'], 'sum of 3D engine utilisation across adapters');
    emit('gpu.vram.used', data['gpuDedicatedBytes']);

    return out;
  }

  private allUnknown(nowMs: number, status: 'unavailable' | 'invalid', note: string): Reading[] {
    return this.metrics.map((metric) =>
      unknownReading({ metric, timestampMs: nowMs, source: this.id, status, note }),
    );
  }
}
