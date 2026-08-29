import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FixedClock } from '../../src/core/clock.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { reading, unknownReading } from '../../src/domain/telemetry.js';
import type { MetricId, Reading, TelemetrySnapshot } from '../../src/domain/telemetry.js';
import { crossValidate, validateReading, METRIC_BOUNDS } from '../../src/telemetry/validation.js';
import { TelemetryPipeline } from '../../src/telemetry/pipeline.js';
import { summarize, summarizeMetric, isSignificantChange, percentile } from '../../src/telemetry/summary.js';
import { sealSource } from '../../src/telemetry/source.js';
import type { TelemetrySource } from '../../src/telemetry/source.js';
import { MockTelemetrySource, SIMULATED_GAMING, SIMULATED_IDLE } from '../../src/telemetry/sources/mock.js';
import { OsMemorySource } from '../../src/telemetry/sources/os-memory.js';
import { SelfTelemetrySource } from '../../src/telemetry/sources/self.js';
import { SensorBridgeSource } from '../../src/telemetry/sources/sensor-bridge.js';

const logger = createLogger(new MemorySink(), 'debug');
const T0 = 1_700_000_000_000;

function ok(metric: MetricId, value: number, overrides: Partial<Reading> = {}): Reading {
  return { ...reading({ metric, value, timestampMs: T0, source: 'test', fidelity: 'live' }), ...overrides };
}

describe('reading construction', () => {
  it('never lets an unknown reading carry a value', () => {
    const r = unknownReading({ metric: 'cpu.temperature', timestampMs: T0, source: 'test', status: 'unavailable' });
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.status).not.toBe('ok');
  });

  it('distinguishes unknown from zero', () => {
    const zero = ok('cpu.utilization', 0);
    const unknown = unknownReading({ metric: 'cpu.utilization', timestampMs: T0, source: 'test', status: 'unavailable' });
    expect(zero.value).toBe(0);
    expect(zero.status).toBe('ok');
    expect(unknown.value).toBeNull();
    expect(zero.value === unknown.value).toBe(false);
  });
});

describe('validateReading', () => {
  it('accepts a plausible value', () => {
    expect(validateReading(ok('cpu.temperature', 55), T0).rejected).toBe(false);
  });

  it('rejects a temperature well outside physical range', () => {
    const result = validateReading(ok('cpu.temperature', 4000), T0);
    expect(result.rejected).toBe(true);
    expect(result.reading.status).toBe('invalid');
    expect(result.reading.value).toBeNull();
  });

  it('allows CPU utilisation above 100 because boost makes that real', () => {
    expect(validateReading(ok('cpu.utilization', 128), T0).rejected).toBe(false);
    expect(METRIC_BOUNDS['cpu.utilization'].max).toBeGreaterThan(100);
  });

  it('rejects the absurd clock values seen after a Ryzen suspend/resume', () => {
    expect(validateReading(ok('cpu.clock', 999_999), T0).rejected).toBe(true);
    expect(validateReading(ok('cpu.clock', 5_700), T0).rejected).toBe(false);
  });

  it('rejects NaN rather than passing it downstream', () => {
    const r = { ...ok('cpu.temperature', 50), value: Number.NaN } as Reading;
    expect(validateReading(r, T0).rejected).toBe(true);
  });

  it('marks an old reading stale rather than using it', () => {
    const result = validateReading(ok('cpu.temperature', 55), T0 + 120_000);
    expect(result.rejected).toBe(true);
    expect(result.reading.status).toBe('stale');
  });

  it('rejects a reading timestamped in the future', () => {
    const result = validateReading(ok('cpu.temperature', 55), T0 - 60_000);
    expect(result.rejected).toBe(true);
  });

  it('leaves an already-unknown reading untouched', () => {
    const r = unknownReading({ metric: 'gpu.hotspot', timestampMs: T0, source: 'test', status: 'unsupported' });
    const result = validateReading(r, T0 + 10_000_000);
    expect(result.rejected).toBe(false);
    expect(result.reading.status).toBe('unsupported');
  });
});

describe('crossValidate', () => {
  it('demotes both readings when used exceeds total', () => {
    const out = crossValidate([ok('gpu.vram.used', 30 * 1024 ** 3), ok('gpu.vram.total', 20 * 1024 ** 3)]);
    expect(out.every((r) => r.status === 'invalid')).toBe(true);
  });

  it('tolerates a small overshoot as measurement skew', () => {
    const out = crossValidate([ok('memory.used', 101), ok('memory.total', 100)]);
    expect(out.every((r) => r.status === 'ok')).toBe(true);
  });
});

describe('sealSource fidelity clamping', () => {
  it('stops a mock source claiming a live reading', async () => {
    const liar: TelemetrySource = {
      id: 'liar',
      trust: 'mocked',
      metrics: ['cpu.temperature'],
      async sample() {
        return [reading({ metric: 'cpu.temperature', value: 40, timestampMs: T0, source: 'liar', fidelity: 'live' })];
      },
    };
    const sealed = sealSource(liar);
    const [r] = await sealed.sample({ clock: new FixedClock(T0), logger, timeoutMs: 1000 });
    expect(r?.fidelity).toBe('mocked');
  });

  it('does not upgrade a weaker claim from a live source', async () => {
    const cautious: TelemetrySource = {
      id: 'cautious',
      trust: 'live',
      metrics: ['cpu.temperature'],
      async sample() {
        return [reading({ metric: 'cpu.temperature', value: 40, timestampMs: T0, source: 'c', fidelity: 'unverified' })];
      },
    };
    const [r] = await sealSource(cautious).sample({ clock: new FixedClock(T0), logger, timeoutMs: 1000 });
    expect(r?.fidelity).toBe('unverified');
  });
});

describe('TelemetryPipeline', () => {
  function pipeline(overrides = {}) {
    return new TelemetryPipeline({ clock: new FixedClock(T0), logger, ...overrides });
  }

  it('produces a mocked snapshot from a mocked source', async () => {
    const p = pipeline();
    p.register(new MockTelemetrySource(SIMULATED_IDLE));
    const snapshot = await p.sampleOnce();
    expect(snapshot.fidelity).toBe('mocked');
    expect(snapshot.readings.length).toBeGreaterThan(5);
  });

  it('reports unavailable fidelity when nothing produced a number', async () => {
    const p = pipeline();
    p.register({
      id: 'dead',
      trust: 'live',
      metrics: ['cpu.temperature'],
      async sample() {
        return [unknownReading({ metric: 'cpu.temperature', timestampMs: T0, source: 'dead', status: 'unavailable' })];
      },
    });
    const snapshot = await p.sampleOnce();
    expect(snapshot.fidelity).toBe('unavailable');
    expect(p.working).toBe(false);
  });

  it('survives a source that throws and marks it degraded', async () => {
    const p = pipeline();
    p.register({
      id: 'boom',
      trust: 'live',
      metrics: ['cpu.temperature'],
      async sample(): Promise<Reading[]> {
        throw new Error('sensor exploded');
      },
    });
    p.register(new MockTelemetrySource(SIMULATED_IDLE));
    for (let i = 0; i < 3; i += 1) await p.sampleOnce();
    const health = p.sourceHealth().find((h) => h.id === 'boom');
    expect(health?.degraded).toBe(true);
    expect(health?.lastErrorMessage).toContain('sensor exploded');
    expect(p.working).toBe(true);
  });

  it('survives a source that hangs', async () => {
    const p = pipeline({ sampleTimeoutMs: 20 });
    p.register({
      id: 'hang',
      trust: 'live',
      metrics: ['cpu.temperature'],
      async sample(): Promise<Reading[]> {
        return new Promise(() => undefined);
      },
    });
    const snapshot = await p.sampleOnce();
    expect(snapshot.readings).toHaveLength(0);
    expect(p.sourceHealth()[0]?.consecutiveFailures).toBe(1);
  });

  it('prefers a live reading over a mocked one for the same metric', async () => {
    const p = pipeline();
    p.register(new MockTelemetrySource(SIMULATED_IDLE));
    p.register({
      id: 'real',
      trust: 'live',
      metrics: ['cpu.temperature'],
      async sample() {
        return [reading({ metric: 'cpu.temperature', value: 61, timestampMs: T0, source: 'real', fidelity: 'live' })];
      },
    });
    const snapshot = await p.sampleOnce();
    const cpuTemp = snapshot.readings.filter((r) => r.metric === 'cpu.temperature');
    expect(cpuTemp).toHaveLength(1);
    expect(cpuTemp[0]?.value).toBe(61);
    expect(cpuTemp[0]?.fidelity).toBe('live');
  });

  it('requires sustained load before speeding up sampling', async () => {
    const clock = new FixedClock(T0);
    const p = new TelemetryPipeline({ clock, logger, dwellSamples: 2 });
    const source = new MockTelemetrySource(SIMULATED_IDLE);
    p.register(source);

    await p.sampleOnce();
    expect(p.currentMode).toBe('low_activity');

    source.setProfile(SIMULATED_GAMING);
    clock.advance(1000);
    await p.sampleOnce();
    expect(p.currentMode).toBe('low_activity'); // one busy sample is not enough
    clock.advance(1000);
    await p.sampleOnce();
    expect(p.currentMode).toBe('active_workload');
    expect(p.currentIntervalMs).toBeLessThan(30_000);
  });

  it('requires sustained idle before slowing down again', async () => {
    const clock = new FixedClock(T0);
    const p = new TelemetryPipeline({ clock, logger, dwellSamples: 2 });
    const source = new MockTelemetrySource(SIMULATED_GAMING);
    p.register(source);
    await p.sampleOnce();
    await p.sampleOnce();
    await p.sampleOnce();
    expect(p.currentMode).toBe('active_workload');

    source.setProfile(SIMULATED_IDLE);
    await p.sampleOnce();
    expect(p.currentMode).toBe('active_workload');
    await p.sampleOnce();
    expect(p.currentMode).toBe('low_activity');
  });

  it('enters and leaves the bounded optimization sampling window', async () => {
    const clock = new FixedClock(T0);
    const p = new TelemetryPipeline({ clock, logger });
    p.register(new MockTelemetrySource(SIMULATED_IDLE));
    p.enterOptimizationMode(5_000);
    expect(p.currentMode).toBe('optimization');
    expect(p.currentIntervalMs).toBe(1_000);
    p.exitOptimizationMode();
    expect(p.currentMode).toBe('low_activity');
  });

  it('keeps history bounded', async () => {
    const p = pipeline({ historyLimit: 3 });
    p.register(new MockTelemetrySource(SIMULATED_IDLE));
    for (let i = 0; i < 10; i += 1) await p.sampleOnce();
    expect(p.history()).toHaveLength(3);
  });

  it('notifies snapshot listeners and survives a listener that throws', async () => {
    const p = pipeline();
    p.register(new MockTelemetrySource(SIMULATED_IDLE));
    const seen: TelemetrySnapshot[] = [];
    p.onSnapshot(() => {
      throw new Error('listener blew up');
    });
    p.onSnapshot((s) => seen.push(s));
    await p.sampleOnce();
    expect(seen).toHaveLength(1);
  });
});

describe('summaries', () => {
  function snapshotWith(values: readonly (number | null)[]): TelemetrySnapshot[] {
    return values.map((v, i) => ({
      timestampMs: T0 + i * 1000,
      samplingMode: 'active_workload' as const,
      fidelity: 'live' as const,
      readings: [
        v === null
          ? unknownReading({ metric: 'cpu.utilization', timestampMs: T0 + i * 1000, source: 't', status: 'unavailable' })
          : ok('cpu.utilization', v, { timestampMs: T0 + i * 1000 }),
      ],
    }));
  }

  it('computes coverage from attempted samples', () => {
    const summary = summarizeMetric(snapshotWith([10, null, 30, null]), 'cpu.utilization');
    expect(summary.samples).toBe(2);
    expect(summary.coverage).toBe(0.5);
    expect(summary.mean).toBe(20);
  });

  it('returns nulls rather than zeros when nothing was measured', () => {
    const summary = summarizeMetric(snapshotWith([null, null]), 'cpu.utilization');
    expect(summary.samples).toBe(0);
    expect(summary.mean).toBeNull();
    expect(summary.min).toBeNull();
    expect(summary.fidelity).toBe('unavailable');
  });

  it('summarises the whole snapshot set', () => {
    const summary = summarize(snapshotWith([10, 20, 30]));
    expect(summary.sampleCount).toBe(3);
    expect(summary.metrics[0]?.max).toBe(30);
  });

  it('computes percentiles by interpolation', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('treats a change below the noise floor as insignificant', () => {
    expect(isSignificantChange('cpu.utilization', 2)).toBe(false);
    expect(isSignificantChange('cpu.utilization', 9)).toBe(true);
  });
});

describe('OsMemorySource', () => {
  it('reports real memory for this host', async () => {
    const readings = await new OsMemorySource().sample({ clock: new FixedClock(T0), logger, timeoutMs: 1000 });
    const total = readings.find((r) => r.metric === 'memory.total');
    expect(total?.status).toBe('ok');
    expect(total?.value).toBeGreaterThan(0);
  });
});

describe('SelfTelemetrySource', () => {
  it('always reports its own memory and reports CPU from the second sample', async () => {
    const source = new SelfTelemetrySource();
    const context = { clock: new FixedClock(T0), logger, timeoutMs: 1000 };
    const first = await source.sample(context);
    expect(first.find((r) => r.metric === 'nexus.self.rss')?.status).toBe('ok');
    expect(first.find((r) => r.metric === 'nexus.self.cpu')).toBeUndefined();
    const second = await source.sample(context);
    expect(second.find((r) => r.metric === 'nexus.self.cpu')?.status).toBe('ok');
  });
});

describe('SensorBridgeSource', () => {
  async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-bridge-'));
    try {
      await fn(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('reports every metric unavailable when no helper is installed', async () => {
    await withHome(async (home) => {
      const source = new SensorBridgeSource({ paths: resolvePaths(home) });
      const readings = await source.sample({ clock: new FixedClock(T0), logger, timeoutMs: 1000 });
      expect(readings.length).toBe(source.metrics.length);
      expect(readings.every((r) => r.value === null)).toBe(true);
      expect(readings[0]?.note).toContain('no sensor bridge');
    });
  });

  it('accepts a fresh, well-formed document', async () => {
    await withHome(async (home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.runtime, { recursive: true });
      await writeFile(
        path.join(paths.runtime, 'sensors.json'),
        JSON.stringify({
          version: 1,
          producer: 'test-helper',
          capturedAtMs: T0,
          readings: [
            { metric: 'cpu.temperature', value: 62 },
            { metric: 'gpu.hotspot', value: 84 },
          ],
        }),
      );
      const source = new SensorBridgeSource({ paths });
      const readings = await source.sample({ clock: new FixedClock(T0 + 1000), logger, timeoutMs: 1000 });
      const cpu = readings.find((r) => r.metric === 'cpu.temperature');
      expect(cpu?.value).toBe(62);
      expect(cpu?.fidelity).toBe('live');
      expect(source.producer).toBe('test-helper');
      expect(readings.find((r) => r.metric === 'gpu.power')?.value).toBeNull();
    });
  });

  it('marks a stale document stale rather than using it', async () => {
    await withHome(async (home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.runtime, { recursive: true });
      await writeFile(
        path.join(paths.runtime, 'sensors.json'),
        JSON.stringify({ version: 1, producer: 'x', capturedAtMs: T0, readings: [{ metric: 'cpu.temperature', value: 62 }] }),
      );
      const source = new SensorBridgeSource({ paths });
      const readings = await source.sample({ clock: new FixedClock(T0 + 600_000), logger, timeoutMs: 1000 });
      expect(readings.every((r) => r.status === 'stale')).toBe(true);
      expect(readings.every((r) => r.value === null)).toBe(true);
    });
  });

  it('rejects a document with an unknown field', async () => {
    await withHome(async (home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.runtime, { recursive: true });
      await writeFile(
        path.join(paths.runtime, 'sensors.json'),
        JSON.stringify({ version: 1, producer: 'x', capturedAtMs: T0, readings: [], trustMe: true }),
      );
      const source = new SensorBridgeSource({ paths });
      const readings = await source.sample({ clock: new FixedClock(T0), logger, timeoutMs: 1000 });
      expect(readings[0]?.note).toContain('rejected');
    });
  });

  it('ignores a metric the bridge is not allowed to supply', async () => {
    await withHome(async (home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.runtime, { recursive: true });
      await writeFile(
        path.join(paths.runtime, 'sensors.json'),
        JSON.stringify({
          version: 1,
          producer: 'x',
          capturedAtMs: T0,
          readings: [
            { metric: 'nexus.self.cpu', value: 0 },
            { metric: 'not.a.real.metric', value: 5 },
            { metric: 'cpu.temperature', value: 50 },
          ],
        }),
      );
      const source = new SensorBridgeSource({ paths });
      const readings = await source.sample({ clock: new FixedClock(T0), logger, timeoutMs: 1000 });
      expect(readings.find((r) => r.metric === 'cpu.temperature')?.value).toBe(50);
      expect(readings.some((r) => (r.metric as string) === 'not.a.real.metric')).toBe(false);
      expect(readings.some((r) => r.metric === 'nexus.self.cpu')).toBe(false);
    });
  });
});
