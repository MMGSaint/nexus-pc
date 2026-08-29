/**
 * External sensor bridge.
 *
 * There is no in-box Windows interface that reports CPU die temperature, GPU
 * temperature, hotspot temperature, fan speed or board power. Those values
 * come from the silicon through paths that need a ring-0 driver or a vendor
 * library:
 *
 *   - CPU package/die temperature, per-core clocks, package power: a ring-0
 *     helper such as LibreHardwareMonitorLib, or a running HWiNFO instance.
 *   - AMD GPU temperature, hotspot, fan RPM, board power, GPU clocks: AMD's
 *     ADLX library, which ships inside the AMD display driver and has no
 *     command-line or WMI surface — it must be reached from native code.
 *
 * NEXUS does not embed any of those. Instead it defines this bridge: an
 * optional, separately installed helper writes a small JSON document into the
 * NEXUS runtime directory, and NEXUS reads it. Until such a helper exists the
 * capability is simply unavailable — which is why NEXUS refuses temperature-
 * gated controls on a stock machine rather than guessing at a temperature.
 *
 * Trust boundary: the document must live inside the NEXUS home, which is a
 * per-user directory created with restrictive permissions. Anything able to
 * write there already runs as the user. Values are still range-checked and
 * age-checked like any other reading, so a stale or implausible document
 * cannot satisfy a thermal precondition.
 */

import path from 'node:path';

import type { NexusPaths } from '../../core/paths.js';
import { readJson } from '../../core/fsx.js';
import {
  vArray,
  vNumber,
  vObject,
  vOptional,
  vString,
} from '../../core/validate.js';
import { METRIC_IDS } from '../../domain/telemetry.js';
import type { MetricId, Reading } from '../../domain/telemetry.js';
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export const SENSOR_BRIDGE_FILENAME = 'sensors.json';

/** Metrics a bridge is allowed to supply. Deliberately a closed set. */
export const BRIDGE_METRICS: readonly MetricId[] = Object.freeze([
  'cpu.temperature',
  'cpu.power',
  'cpu.clock',
  'gpu.temperature',
  'gpu.hotspot',
  'gpu.power',
  'gpu.clock',
  'gpu.fan.rpm',
  'gpu.fan.percent',
  'gpu.vram.used',
  'gpu.vram.total',
  'storage.temperature',
  'system.fan.rpm',
]);

const bridgeSchema = vObject({
  /** Contract version, so an old helper can be refused rather than misread. */
  version: vNumber({ integer: true, min: 1, max: 1 }),
  /** Identifier of the helper, recorded in the audit trail. */
  producer: vString({ maxLength: 128 }),
  producerVersion: vOptional(vString({ maxLength: 64 })),
  /** Wall-clock milliseconds when the helper took the readings. */
  capturedAtMs: vNumber({ min: 0 }),
  readings: vArray(
    vObject({
      metric: vString({ maxLength: 64 }),
      value: vNumber(),
      note: vOptional(vString({ maxLength: 256 })),
    }),
    { maxItems: 64 },
  ),
});

const KNOWN_METRICS = new Set<string>(METRIC_IDS);
const ALLOWED = new Set<string>(BRIDGE_METRICS);

export interface SensorBridgeOptions {
  readonly paths: NexusPaths;
  /** Readings older than this are reported stale rather than used. */
  readonly maxAgeMs?: number;
}

export class SensorBridgeSource implements TelemetrySource {
  readonly id = 'sensor.bridge';
  /**
   * `live`: the helper reads real silicon. It is still validated, aged and
   * clamped like every other source, and reports `unavailable` when absent.
   */
  readonly trust = 'live' as const;
  readonly metrics: readonly MetricId[] = BRIDGE_METRICS;

  private readonly file: string;
  private readonly maxAgeMs: number;
  private lastProducer: string | null = null;

  constructor(options: SensorBridgeOptions) {
    this.file = path.join(options.paths.runtime, SENSOR_BRIDGE_FILENAME);
    this.maxAgeMs = options.maxAgeMs ?? 15_000;
  }

  get bridgeFile(): string {
    return this.file;
  }

  get producer(): string | null {
    return this.lastProducer;
  }

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const nowMs = context.clock.now();
    const document = await readJson(this.file, bridgeSchema);

    if (!document.ok) {
      this.lastProducer = null;
      const note =
        document.error.code === 'E_UNAVAILABLE'
          ? 'no sensor bridge is installed; see docs/telemetry.md'
          : `sensor bridge document rejected: ${document.error.message}`;
      return this.metrics.map((metric) =>
        unknownReading({ metric, timestampMs: nowMs, source: this.id, status: 'unavailable', note }),
      );
    }

    const doc = document.value;
    this.lastProducer = doc.producer;
    const age = nowMs - doc.capturedAtMs;

    if (age > this.maxAgeMs) {
      return this.metrics.map((metric) =>
        unknownReading({
          metric,
          timestampMs: doc.capturedAtMs,
          source: this.id,
          status: 'stale',
          note: `sensor bridge document is ${Math.round(age / 1000)}s old; the helper may have stopped`,
        }),
      );
    }

    const supplied = new Map<MetricId, Reading>();
    for (const entry of doc.readings) {
      // An unknown or out-of-contract metric name is discarded, not invented.
      if (!KNOWN_METRICS.has(entry.metric) || !ALLOWED.has(entry.metric)) continue;
      const metric = entry.metric as MetricId;
      supplied.set(
        metric,
        reading({
          metric,
          value: entry.value,
          timestampMs: doc.capturedAtMs,
          source: `${this.id}:${doc.producer}`,
          fidelity: 'live',
          confidence: 0.95,
          ...(entry.note === undefined ? {} : { note: entry.note }),
        }),
      );
    }

    return this.metrics.map(
      (metric) =>
        supplied.get(metric) ??
        unknownReading({
          metric,
          timestampMs: nowMs,
          source: this.id,
          status: 'unavailable',
          note: `the installed sensor bridge (${doc.producer}) does not report this metric`,
        }),
    );
  }
}
