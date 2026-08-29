/**
 * NEXUS measuring itself.
 *
 * Required by design: NEXUS is part of the workload it optimises, so its own
 * cost has to be observable and auditable rather than assumed negligible.
 */

import type { MetricId, Reading } from '../../domain/telemetry.js';
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export class SelfTelemetrySource implements TelemetrySource {
  readonly id = 'nexus.self';
  readonly trust = 'live' as const;
  readonly metrics: readonly MetricId[] = ['nexus.self.cpu', 'nexus.self.rss'];

  private lastUsage: NodeJS.CpuUsage | null = null;
  private lastMs: number | null = null;

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const nowMs = context.clock.now();
    const monotonic = context.clock.monotonic();
    const out: Reading[] = [
      reading({
        metric: 'nexus.self.rss',
        value: process.memoryUsage.rss(),
        timestampMs: nowMs,
        source: this.id,
        fidelity: 'live',
      }),
    ];

    // The first sample has no interval to compare against. Emitting an
    // explicit unknown rather than omitting the metric keeps the gap visible
    // in coverage, which is the whole point of tracking coverage.
    if (this.lastUsage === null || this.lastMs === null) {
      out.push(
        unknownReading({
          metric: 'nexus.self.cpu',
          timestampMs: nowMs,
          source: this.id,
          status: 'unavailable',
          note: 'awaiting a second sample; a rate needs an interval',
          fidelity: 'live',
        }),
      );
    }

    if (this.lastUsage !== null && this.lastMs !== null) {
      const delta = process.cpuUsage(this.lastUsage);
      const wallMs = Math.max(1, monotonic - this.lastMs);
      const cpuMs = (delta.user + delta.system) / 1000;
      out.push(
        reading({
          metric: 'nexus.self.cpu',
          value: (cpuMs / wallMs) * 100,
          timestampMs: nowMs,
          source: this.id,
          fidelity: 'live',
          note: 'percentage of one core since the previous sample',
        }),
      );
    }

    this.lastUsage = process.cpuUsage();
    this.lastMs = monotonic;
    return out;
  }
}
