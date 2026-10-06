/**
 * LibreHardwareMonitor bridge.
 *
 * BORROWED-INTEGRATION: this consumes LHM's documented local /data.json API
 * instead of reimplementing motherboard, CPU and GPU sensor access in NEXUS.
 * LHM remains a separate process; NEXUS owns only parsing, freshness and
 * metric selection.
 *
 * Source: LibreHardwareMonitor (MPL-2.0; see docs/third-party.md).
 *
 * The web server exposes formatted values as strings (for example "46.9 °C").
 * We intentionally parse the displayed numeric value rather than treating the
 * "RawValue" field as raw bytes/units because the upstream project documents
 * that field as formatted too in current releases/issues.
 */

import type { Clock } from '../../core/clock.js';
import type { Logger } from '../../core/logger.js';
import type { MetricId, Reading } from '../../domain/telemetry.js';
import { METRIC_IDS, reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export interface LibreHardwareMonitorOptions {
  readonly url?: string;
  readonly timeoutMs?: number;
}

interface LhmNode {
  readonly Text?: unknown;
  readonly Type?: unknown;
  readonly Value?: unknown;
  readonly SensorId?: unknown;
  readonly Children?: unknown;
}

interface SensorLeaf {
  readonly id: string;
  readonly text: string;
  readonly type: string;
  readonly value: number;
  readonly path: string;
}

const METRICS: readonly MetricId[] = Object.freeze([
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
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.replace(/,/g, '.').match(/[-+]?\d+(?:\.\d+)?/);
  if (!match?.[0]) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function walk(node: unknown, parents: string[], out: SensorLeaf[]): void {
  if (!isRecord(node)) return;
  const currentText = text(node.Text);
  const nextParents = currentText ? [...parents, currentText] : parents;
  const type = text(node.Type);
  const sensorId = text(node.SensorId);
  const value = finiteNumber(node.Value);
  if (sensorId && type && value !== null) {
    out.push({
      id: sensorId,
      text: currentText,
      type,
      value,
      path: nextParents.join(' / '),
    });
  }
  if (Array.isArray(node.Children)) {
    for (const child of node.Children) walk(child, nextParents, out);
  }
}

function isGpuPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes('gpu') || p.includes('radeon') || p.includes('graphics');
}

function isCpuPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes('cpu') || p.includes('ryzen') || p.includes('processor') || p.includes('amdcpu');
}

function choose(
  sensors: readonly SensorLeaf[],
  metric: MetricId,
): SensorLeaf | null {
  const filtered = sensors.filter((s) => {
    const t = s.type.toLowerCase();
    const n = s.text.toLowerCase();
    const p = s.path.toLowerCase();
    switch (metric) {
      case 'cpu.temperature':
        return t === 'temperature' && isCpuPath(p) && /(tctl|tdie|package|cpu)/.test(n);
      case 'cpu.power':
        return t === 'power' && isCpuPath(p) && /(package|cpu|ppt)/.test(n);
      case 'cpu.clock':
        return t === 'clock' && isCpuPath(p) && /(core|effective|cpu)/.test(n);
      case 'gpu.temperature':
        return t === 'temperature' && isGpuPath(p) && /(gpu core|core|temperature)/.test(n) && !/hot ? spot|hotspot/.test(n);
      case 'gpu.hotspot':
        return t === 'temperature' && isGpuPath(p) && /hot ? spot|hotspot|junction/.test(n);
      case 'gpu.power':
        return t === 'power' && isGpuPath(p) && /(board|total|package|gpu)/.test(n);
      case 'gpu.clock':
        return t === 'clock' && isGpuPath(p) && /(gpu core|core|memory|clock)/.test(n);
      case 'gpu.fan.rpm':
        return t === 'fan' && isGpuPath(p);
      case 'gpu.fan.percent':
        return t === 'control' && isGpuPath(p);
      case 'gpu.vram.used':
        return t === 'data' && isGpuPath(p) && /(memory|vram|used)/.test(n);
      default:
        return false;
    }
  });
  if (filtered.length === 0) return null;

  // Prefer a direct/obvious name and then the first sensor in the tree. The
  // point is deterministic selection, not pretending LHM names are a stable API.
  const score = (s: SensorLeaf): number => {
    const n = s.text.toLowerCase();
    let score = 0;
    if (/^(package|core|gpu core|total board power|hot spot|junction)$/.test(n)) score += 10;
    if (/tdie|tctl|effective|board|vram|memory/.test(n)) score += 4;
    if (s.id.includes('/0/')) score += 1;
    return score;
  };
  return [...filtered].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0] ?? null;
}

export interface LibreHardwareMonitorProbe {
  readonly available: boolean;
  readonly detail: string;
}

export class LibreHardwareMonitorSource implements TelemetrySource {
  readonly id = 'librehardwaremonitor.web';
  readonly trust = 'live' as const;
  readonly metrics = METRICS;

  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(options: LibreHardwareMonitorOptions & { clock: Clock; logger: Logger }) {
    this.clock = options.clock;
    this.logger = options.logger;
    this.url = (options.url ?? 'http://127.0.0.1:8085').replace(/\/$/, '');
    this.timeoutMs = Math.max(250, Math.min(10_000, options.timeoutMs ?? 1500));
  }

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const timestampMs = context.clock.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, context.timeoutMs));
    timer.unref?.();

    let payload: unknown;
    try {
      const response = await fetch(`${this.url}/data.json`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    } catch (error) {
      this.logger.debug('librehardwaremonitor unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return METRICS.map((metric) =>
        unknownReading({
          metric,
          timestampMs,
          source: this.id,
          status: 'unavailable',
          note: 'LibreHardwareMonitor /data.json did not answer.',
        }),
      );
    } finally {
      clearTimeout(timer);
    }

    const sensors: SensorLeaf[] = [];
    walk(payload, [], sensors);

    return METRICS.map((metric) => {
      const chosen = choose(sensors, metric);
      if (!chosen) {
        return unknownReading({
          metric,
          timestampMs,
          source: this.id,
          status: 'unavailable',
          note: 'LHM is reachable but no deterministic sensor match was found.',
        });
      }
      const note = `LHM sensor ${chosen.text || chosen.id} (${chosen.type}); parsed displayed value.`;
      return reading({
        metric,
        value: chosen.value,
        timestampMs,
        source: `${this.id}:${chosen.id}`,
        fidelity: 'live',
        confidence: 0.9,
        note,
      });
    });
  }
}

export function isLibreHardwareMonitorMetric(metric: MetricId): boolean {
  return (METRICS as readonly string[]).includes(metric);
}
