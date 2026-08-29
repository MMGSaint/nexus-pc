/**
 * Linux telemetry, for developing and testing NEXUS on a non-Windows host.
 *
 * Reads /proc/stat for CPU utilisation and /sys/class/hwmon for temperature.
 * These are real measurements of the machine NEXUS is running on, so the
 * source is `live` — which makes it genuinely useful for exercising the
 * thermal gating path against data that actually moves.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { MetricId, Reading } from '../../domain/telemetry.js';
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

interface CpuTotals {
  readonly idle: number;
  readonly total: number;
}

const HWMON_ROOT = '/sys/class/hwmon';

/** hwmon chip names that report a CPU package temperature. */
const CPU_HWMON_NAMES = new Set(['k10temp', 'coretemp', 'zenpower', 'cpu_thermal']);
const GPU_HWMON_NAMES = new Set(['amdgpu', 'nouveau', 'radeon']);

export class LinuxTelemetrySource implements TelemetrySource {
  readonly id = 'linux.procfs';
  readonly trust = 'live' as const;
  readonly metrics: readonly MetricId[] = ['cpu.utilization', 'cpu.temperature', 'gpu.temperature'];

  private previous: CpuTotals | null = null;

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const nowMs = context.clock.now();
    const out: Reading[] = [];

    const totals = await this.readCpuTotals();
    if (totals === null) {
      out.push(
        unknownReading({
          metric: 'cpu.utilization',
          timestampMs: nowMs,
          source: this.id,
          status: 'unavailable',
          note: '/proc/stat was not readable',
        }),
      );
    } else if (this.previous === null) {
      // The first sample has no interval to compare against. Reporting it as
      // unavailable is more honest than reporting a since-boot average.
      this.previous = totals;
      out.push(
        unknownReading({
          metric: 'cpu.utilization',
          timestampMs: nowMs,
          source: this.id,
          status: 'unavailable',
          note: 'awaiting a second sample; a rate needs an interval',
        }),
      );
    } else {
      const idleDelta = totals.idle - this.previous.idle;
      const totalDelta = totals.total - this.previous.total;
      this.previous = totals;
      if (totalDelta <= 0) {
        out.push(
          unknownReading({
            metric: 'cpu.utilization',
            timestampMs: nowMs,
            source: this.id,
            status: 'invalid',
            note: 'counter did not advance between samples',
          }),
        );
      } else {
        out.push(
          reading({
            metric: 'cpu.utilization',
            value: Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)),
            timestampMs: nowMs,
            source: this.id,
            fidelity: 'live',
          }),
        );
      }
    }

    out.push(await this.readHwmonTemperature('cpu.temperature', CPU_HWMON_NAMES, nowMs));
    out.push(await this.readHwmonTemperature('gpu.temperature', GPU_HWMON_NAMES, nowMs));
    return out;
  }

  private async readCpuTotals(): Promise<CpuTotals | null> {
    try {
      const text = await readFile('/proc/stat', 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('cpu '));
      if (!line) return null;
      const fields = line.trim().split(/\s+/).slice(1).map(Number);
      if (fields.some((n) => !Number.isFinite(n))) return null;
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
      const total = fields.reduce((a, b) => a + b, 0);
      return { idle, total };
    } catch {
      return null;
    }
  }

  private async readHwmonTemperature(
    metric: MetricId,
    names: ReadonlySet<string>,
    nowMs: number,
  ): Promise<Reading> {
    try {
      const entries = await readdir(HWMON_ROOT);
      for (const entry of entries) {
        const dir = path.join(HWMON_ROOT, entry);
        const name = (await readFile(path.join(dir, 'name'), 'utf8').catch(() => '')).trim();
        if (!names.has(name)) continue;
        const raw = await readFile(path.join(dir, 'temp1_input'), 'utf8').catch(() => null);
        if (raw === null) continue;
        const milliC = Number(raw.trim());
        if (!Number.isFinite(milliC)) continue;
        return reading({
          metric,
          value: milliC / 1000,
          timestampMs: nowMs,
          source: `${this.id}:${name}`,
          fidelity: 'live',
        });
      }
    } catch {
      /* fall through to unavailable */
    }
    return unknownReading({
      metric,
      timestampMs: nowMs,
      source: this.id,
      status: 'unavailable',
      note: 'no matching hwmon sensor on this host',
    });
  }
}
