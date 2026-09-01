/**
 * Simulated telemetry.
 *
 * Drives the whole pipeline without hardware so that startup, classification,
 * measurement and rollback logic can be exercised end to end. Its trust level
 * is `mocked`, and `sealSource` enforces that even if this class returned a
 * reading labelled `live`, the label would be reduced before anyone saw it.
 *
 * The generator is deterministic: a given step index always produces the same
 * values, so tests do not flake.
 */

import type { MetricId, Reading } from '../../domain/telemetry.js';
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export interface SimulatedProfile {
  readonly cpuUtilization: number;
  readonly gpuUtilization: number;
  readonly cpuTemperatureC: number;
  readonly gpuTemperatureC: number;
  readonly gpuHotspotC: number;
  readonly vramUsedBytes: number;
  readonly vramTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly memoryTotalBytes: number;
}

export const SIMULATED_IDLE: SimulatedProfile = Object.freeze({
  cpuUtilization: 3,
  gpuUtilization: 1,
  cpuTemperatureC: 38,
  gpuTemperatureC: 34,
  gpuHotspotC: 41,
  vramUsedBytes: 1.2 * 1024 ** 3,
  vramTotalBytes: 20 * 1024 ** 3,
  memoryUsedBytes: 12 * 1024 ** 3,
  memoryTotalBytes: 96 * 1024 ** 3,
});

export const SIMULATED_GAMING: SimulatedProfile = Object.freeze({
  cpuUtilization: 42,
  gpuUtilization: 97,
  cpuTemperatureC: 68,
  gpuTemperatureC: 71,
  gpuHotspotC: 88,
  vramUsedBytes: 13 * 1024 ** 3,
  vramTotalBytes: 20 * 1024 ** 3,
  memoryUsedBytes: 28 * 1024 ** 3,
  memoryTotalBytes: 96 * 1024 ** 3,
});

export interface MockTelemetryOptions {
  /** Metrics this source should report as unavailable, to model a missing sensor. */
  readonly unavailableMetrics?: readonly MetricId[];
  /** Deterministic jitter amplitude as a fraction of the base value. */
  readonly jitter?: number;
}

export class MockTelemetrySource implements TelemetrySource {
  readonly id = 'mock.simulated';
  readonly trust = 'mocked' as const;
  readonly metrics: readonly MetricId[] = [
    'cpu.utilization',
    'gpu.utilization',
    'cpu.temperature',
    'gpu.temperature',
    'gpu.hotspot',
    'gpu.vram.used',
    'gpu.vram.total',
    'memory.used',
    'memory.total',
    'memory.available',
  ];

  private profile: SimulatedProfile;
  private readonly unavailable: ReadonlySet<MetricId>;
  private readonly jitter: number;
  private step = 0;

  constructor(profile: SimulatedProfile = SIMULATED_IDLE, options: MockTelemetryOptions = {}) {
    this.profile = profile;
    this.unavailable = new Set(options.unavailableMetrics ?? []);
    this.jitter = options.jitter ?? 0.02;
  }

  setProfile(profile: SimulatedProfile): void {
    this.profile = profile;
  }

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const nowMs = context.clock.now();
    this.step += 1;
    const p = this.profile;

    const emit = (metric: MetricId, value: number, vary = true): Reading => {
      if (this.unavailable.has(metric)) {
        return unknownReading({
          metric,
          timestampMs: nowMs,
          source: this.id,
          status: 'unavailable',
          note: 'this simulated machine has no sensor for this metric',
          fidelity: 'unavailable',
        });
      }
      return reading({
        metric,
        value: vary ? this.vary(value) : value,
        timestampMs: nowMs,
        source: this.id,
        fidelity: 'mocked',
        confidence: 0.9,
        note: 'simulated value',
      });
    };

    return [
      emit('cpu.utilization', p.cpuUtilization),
      emit('gpu.utilization', p.gpuUtilization),
      emit('cpu.temperature', p.cpuTemperatureC),
      emit('gpu.temperature', p.gpuTemperatureC),
      emit('gpu.hotspot', p.gpuHotspotC),
      emit('gpu.vram.used', p.vramUsedBytes),
      emit('gpu.vram.total', p.vramTotalBytes, false),
      emit('memory.used', p.memoryUsedBytes),
      emit('memory.total', p.memoryTotalBytes, false),
      emit('memory.available', p.memoryTotalBytes - p.memoryUsedBytes),
    ];
  }

  /** Deterministic pseudo-jitter: same step, same value, no test flake. */
  private vary(base: number): number {
    const wave = Math.sin(this.step * 1.7) * this.jitter;
    return Math.max(0, base * (1 + wave));
  }
}
