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
import { reading, unknownReading } from '../../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from '../source.js';

export interface LibreHardwareMonitorOptions {
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
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

function parseLocalizedNumber(raw: string): number | null {
  let value = raw.trim().replace(/\s+/g, '');
  if (!value) return null;
  const sign = value.startsWith('-') || value.startsWith('+') ? value.slice(0, 1) : '';
  value = sign ? value.slice(1) : value;
  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // The last punctuation mark is the decimal separator; the other is a
    // thousands separator. Example: 1,234.5 or 1.234,5.
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? /\./g : /,/g;
    value = value.replace(thousands, '').replace(decimal, '.');
  } else if (lastComma >= 0) {
    const trailing = value.length - lastComma - 1;
    value = trailing === 3 && lastComma > 0 ? value.replace(/,/g, '') : value.replace(',', '.');
  } else {
    value = value.replace(/,/g, '');
  }
  const parsed = Number(sign + value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/[-+]?\d[\d\s,.]*/);
  if (!match?.[0]) return null;
  return parseLocalizedNumber(match[0]);
}

function finiteBytes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  const match = normalized.match(/([-+]?\d[\d\s,.]*)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)?/);
  if (!match?.[1]) return null;
  const n = parseLocalizedNumber(match[1]);
  if (n === null) return null;
  const unit = match[2] ?? 'B';
  const factor = unit === 'TB' || unit === 'TIB' ? 1024 ** 4
    : unit === 'GB' || unit === 'GIB' ? 1024 ** 3
    : unit === 'MB' || unit === 'MIB' ? 1024 ** 2
    : unit === 'KB' || unit === 'KIB' ? 1024
    : 1;
  return n * factor;
}

const MAX_SENSOR_NODES = 20_000;
const MAX_SENSOR_DEPTH = 32;

export function validateLhmPayload(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  let nodes = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (!isRecord(node) || depth > MAX_SENSOR_DEPTH) return false;
    nodes += 1;
    if (nodes > MAX_SENSOR_NODES) return false;
    if (node.Children === undefined) return true;
    if (!Array.isArray(node.Children)) return false;
    return node.Children.every((child) => visit(child, depth + 1));
  };
  return visit(payload, 0);
}

function walk(node: unknown, parents: string[], out: SensorLeaf[], depth = 0): void {
  if (!isRecord(node) || depth > MAX_SENSOR_DEPTH || out.length > MAX_SENSOR_NODES) return;
  const currentText = text(node.Text);
  const nextParents = currentText ? [...parents, currentText] : parents;
  const type = text(node.Type);
  const sensorId = text(node.SensorId);
  const numericValue = node.Type && String(node.Type).toLowerCase() === 'data' ? finiteBytes(node.Value) : finiteNumber(node.Value);
  const value = numericValue;
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
    for (const child of node.Children) walk(child, nextParents, out, depth + 1);
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

  private readonly logger: Logger;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointError: string | null;

  constructor(options: LibreHardwareMonitorOptions & { clock?: Clock; logger: Logger }) {
    this.logger = options.logger;
    this.url = (options.url ?? 'http://127.0.0.1:8085').replace(/\/$/, '');
    this.timeoutMs = Math.max(250, Math.min(10_000, options.timeoutMs ?? 1500));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpointError = validateLocalLhmEndpoint(this.url);
  }

  async sample(context: SampleContext): Promise<readonly Reading[]> {
    const timestampMs = context.clock.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, context.timeoutMs));
    timer.unref?.();

    const endpointError = this.endpointError;
    if (endpointError) {
      return METRICS.map((metric) => unknownReading({
        metric,
        timestampMs,
        source: this.id,
        status: 'unsupported',
        note: endpointError,
      }));
    }

    let payload: unknown;
    try {
      const response = await this.fetchImpl(`${this.url}/data.json`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
      if (!validateLhmPayload(payload)) throw new Error('LHM payload failed schema/depth validation');
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


function validateLocalLhmEndpoint(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'LibreHardwareMonitor endpoint is not a valid URL.';
  }

  if (url.protocol !== 'http:') return 'LibreHardwareMonitor endpoint must use local HTTP.';
  if (url.username || url.password) return 'LibreHardwareMonitor endpoint must not contain credentials.';
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    return 'LibreHardwareMonitor endpoint must remain on loopback.';
  }
  return null;
}
