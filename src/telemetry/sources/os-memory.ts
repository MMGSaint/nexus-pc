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

    return [
      make('memory.total', total),
      make('memory.available', available),
      make('memory.used', Math.max(0, total - available)),
    ];
  }
}
