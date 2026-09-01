/**
 * System memory from Node's own APIs.
 *
 * On Windows `os.freemem()` is `GlobalMemoryStatusEx().ullAvailPhys`, which is
 * what Task Manager calls "Available" and includes the reclaimable standby
 * list. That is the number a user recognises. It is deliberately not the same
 * as WMI's `FreePhysicalMemory`, which counts only free and zeroed pages and
 * reads alarmingly low on any machine with a warm file cache.
 *
 * No subprocess, so this is cheap enough to sample at any rate.
 */

import { freemem, totalmem } from 'node:os';

import type { MetricId, Reading } from '../../domain/telemetry.js';
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export class OsMemorySource implements TelemetrySource {
  readonly id = 'os.memory';
  readonly trust = 'live' as const;
  readonly metrics: readonly MetricId[] = ['memory.total', 'memory.available', 'memory.used'];

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const nowMs = context.clock.now();
    const total = totalmem();
    const available = freemem();

    if (!Number.isFinite(total) || total <= 0) {
      return this.metrics.map((metric) =>
        unknownReading({
          metric,
          timestampMs: nowMs,
          source: this.id,
          status: 'unavailable',
          note: 'the operating system did not report a usable memory total',
        }),
      );
    }

    const make = (metric: MetricId, value: number): Reading =>
      reading({ metric, value, timestampMs: nowMs, source: this.id, fidelity: 'live' });

    const readings = [make('memory.total', total), make('memory.available', available)];

    // Clamping would publish `used = 0` as a real measurement when the two
    // figures disagree. An impossible pair means one of them is wrong, and
    // "unknown" is the honest derived value.
    if (Number.isFinite(available) && available >= 0 && available <= total) {
      readings.push(make('memory.used', total - available));
    } else {
      readings.push(
        unknownReading({
          metric: 'memory.used',
          timestampMs: nowMs,
          source: this.id,
          status: 'invalid',
          note: `available memory (${available}) is not consistent with the total (${total})`,
          fidelity: 'live',
        }),
      );
    }
    return readings;
  }
}
