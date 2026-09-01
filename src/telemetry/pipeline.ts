/**
 * The telemetry pipeline.
 *
 * Sources are sampled together, validated, cross-checked, and folded into a
 * snapshot whose fidelity is the weakest of its contributing readings. The
 * pipeline also owns adaptive sampling, because sampling rate is a resource
 * decision and NEXUS is itself part of the workload it is measuring.
 *
 * Sampling modes:
 *   low_activity     the machine is idle; sample rarely
 *   active_workload  something is running; sample often enough to be useful
 *   optimization     a change is being measured; sample at high resolution,
 *                    for a bounded window only
 *   suspended        not sampling at all
 *
 * Transitions use separate enter/exit thresholds and a dwell requirement, so a
 * single spike does not flip the machine into fast sampling and a brief lull
 * does not drop it out mid-workload.
 */

import type { Clock } from '../core/clock.js';
import type { Fidelity } from '../core/fidelity.js';
import { combineFidelity } from '../core/fidelity.js';
import type { Logger } from '../core/logger.js';
import type { MetricId, Reading, SamplingMode, TelemetrySnapshot } from '../domain/telemetry.js';
import { isKnown } from '../domain/telemetry.js';
import type { SampleContext, TelemetrySource } from './source.js';
import { sealSource } from './source.js';
import { crossValidate, validateReading } from './validation.js';

export interface SamplingIntervals {
  readonly low_activity: number;
  readonly active_workload: number;
  readonly optimization: number;
}

export const DEFAULT_INTERVALS: SamplingIntervals = Object.freeze({
  low_activity: 30_000,
  active_workload: 5_000,
  optimization: 1_000,
});

export interface PipelineOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervals?: SamplingIntervals;
  readonly historyLimit?: number;
  readonly sampleTimeoutMs?: number;
  /** NEXUS's own CPU ceiling, as a percentage of one core. */
  readonly selfCpuBudgetPercent?: number;
  /** Utilisation at or above which the machine counts as active. */
  readonly activeEnterPercent?: number;
  /** Utilisation below which it counts as idle again. */
  readonly activeExitPercent?: number;
  /** Consecutive samples required before a mode change takes effect. */
  readonly dwellSamples?: number;
}

export interface SourceHealth {
  readonly id: string;
  readonly trust: Fidelity;
  readonly consecutiveFailures: number;
  readonly lastErrorMessage: string | null;
  readonly lastSuccessMs: number | null;
  readonly degraded: boolean;
}

/** A source is considered degraded after this many consecutive failures. */
export const DEGRADED_AFTER_FAILURES = 3;

/**
 * Shortest interval over which NEXUS will estimate its own CPU use. Below
 * this, scheduler jitter dominates and the figure is meaningless.
 */
export const MIN_SELF_CPU_WINDOW_MS = 2_000;

export class TelemetryPipeline {
  private readonly sources: TelemetrySource[] = [];
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly intervals: SamplingIntervals;
  private readonly historyLimit: number;
  private readonly sampleTimeoutMs: number;
  private readonly selfCpuBudgetPercent: number;
  private readonly activeEnter: number;
  private readonly activeExit: number;
  private readonly dwellSamples: number;

  private readonly snapshots: TelemetrySnapshot[] = [];
  private readonly health = new Map<string, SourceHealth>();
  private readonly listeners = new Set<(s: TelemetrySnapshot) => void>();

  private mode: SamplingMode = 'low_activity';
  private pendingMode: SamplingMode | null = null;
  private pendingCount = 0;
  private optimizationUntilMs: number | null = null;
  private modeBeforeOptimization: SamplingMode = 'low_activity';

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private sampling = false;
  private backoffMultiplier = 1;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuSampleMs: number | null = null;
  private selfCpuPercent: number | null = null;

  constructor(options: PipelineOptions) {
    this.clock = options.clock;
    this.logger = options.logger.child('telemetry');
    this.intervals = options.intervals ?? DEFAULT_INTERVALS;
    this.historyLimit = options.historyLimit ?? 720;
    this.sampleTimeoutMs = options.sampleTimeoutMs ?? 4_000;
    this.selfCpuBudgetPercent = options.selfCpuBudgetPercent ?? 2;
    this.activeEnter = options.activeEnterPercent ?? 25;
    this.activeExit = options.activeExitPercent ?? 12;
    this.dwellSamples = options.dwellSamples ?? 2;
  }

  register(source: TelemetrySource): void {
    const sealed = sealSource(source);
    this.sources.push(sealed);
    this.health.set(sealed.id, {
      id: sealed.id,
      trust: sealed.trust,
      consecutiveFailures: 0,
      lastErrorMessage: null,
      lastSuccessMs: null,
      degraded: false,
    });
  }

  get registeredSources(): readonly string[] {
    return this.sources.map((s) => s.id);
  }

  get currentMode(): SamplingMode {
    return this.mode;
  }

  get currentIntervalMs(): number {
    if (this.mode === 'suspended') return 0;
    return Math.round(this.intervals[this.mode] * this.backoffMultiplier);
  }

  get selfCpuPercentEstimate(): number | null {
    return this.selfCpuPercent;
  }

  sourceHealth(): readonly SourceHealth[] {
    return [...this.health.values()];
  }

  /** True when at least one source produced a usable reading recently. */
  get working(): boolean {
    const latest = this.latest();
    return latest !== null && latest.readings.some(isKnown);
  }

  onSnapshot(listener: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startSources(): Promise<void> {
    for (const source of this.sources) {
      if (!source.start) continue;
      try {
        await source.start(this.context());
      } catch (e) {
        this.recordFailure(source.id, e);
      }
    }
  }

  /** Begin periodic sampling. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const source of this.sources) {
      if (!source.stop) continue;
      try {
        await source.stop();
      } catch (e) {
        this.logger.debug('source stop failed', { source: source.id, error: String(e) });
      }
    }
  }

  /**
   * Raise sampling resolution for a bounded window, e.g. while measuring an
   * optimization. The window is mandatory: high-resolution sampling is never
   * left on by accident.
   */
  enterOptimizationMode(durationMs: number): void {
    if (this.mode !== 'optimization') this.modeBeforeOptimization = this.mode;
    this.mode = 'optimization';
    this.optimizationUntilMs = this.clock.now() + durationMs;
    this.pendingMode = null;
    this.pendingCount = 0;
    this.reschedule();
  }

  exitOptimizationMode(): void {
    if (this.mode !== 'optimization') return;
    this.mode = this.modeBeforeOptimization;
    this.optimizationUntilMs = null;
    this.reschedule();
  }

  suspend(): void {
    this.mode = 'suspended';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resume(): void {
    if (this.mode !== 'suspended') return;
    this.mode = 'low_activity';
    if (this.running) this.scheduleNext(0);
  }

  latest(): TelemetrySnapshot | null {
    return this.snapshots.length > 0 ? (this.snapshots[this.snapshots.length - 1] ?? null) : null;
  }

  history(windowMs?: number): readonly TelemetrySnapshot[] {
    if (windowMs === undefined) return [...this.snapshots];
    const cutoff = this.clock.now() - windowMs;
    return this.snapshots.filter((s) => s.timestampMs >= cutoff);
  }

  /** Sample every source once, validate, and record the snapshot. */
  async sampleOnce(): Promise<TelemetrySnapshot> {
    const startMs = this.clock.now();
    const context = this.context();

    const perSource = await Promise.all(
      this.sources.map(async (source) => {
        try {
          const readings = await withTimeout(source.sample(context), this.sampleTimeoutMs);
          this.recordSuccess(source.id, startMs);
          return readings;
        } catch (e) {
          this.recordFailure(source.id, e);
          return [] as readonly Reading[];
        }
      }),
    );

    const nowMs = this.clock.now();
    const validated: Reading[] = [];
    for (const readings of perSource) {
      for (const reading of readings) {
        const result = validateReading(reading, nowMs);
        if (result.rejected) {
          this.logger.debug('reading rejected', {
            metric: reading.metric,
            source: reading.source,
            reason: result.reason ?? 'unknown',
          });
        }
        validated.push(result.reading);
      }
    }

    const readings = dedupeByMetric(crossValidate(validated));
    const contributing = readings.filter(isKnown).map((r) => r.fidelity);
    const snapshot: TelemetrySnapshot = {
      timestampMs: nowMs,
      readings,
      fidelity: contributing.length === 0 ? 'unavailable' : combineFidelity(...contributing),
      samplingMode: this.mode,
    };

    this.snapshots.push(snapshot);
    while (this.snapshots.length > this.historyLimit) this.snapshots.shift();

    this.updateSelfUsage();
    this.updateMode(snapshot);

    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (e) {
        this.logger.debug('snapshot listener threw', { error: String(e) });
      }
    }

    return snapshot;
  }

  private context(): SampleContext {
    return { clock: this.clock, logger: this.logger, timeoutMs: this.sampleTimeoutMs };
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running || this.mode === 'suspended') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private reschedule(): void {
    if (this.running && !this.sampling) this.scheduleNext(0);
  }

  private async tick(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      if (this.optimizationUntilMs !== null && this.clock.now() >= this.optimizationUntilMs) {
        this.exitOptimizationMode();
      }
      await this.sampleOnce();
    } catch (e) {
      this.logger.warn('sampling tick failed', { error: String(e) });
    } finally {
      this.sampling = false;
      this.scheduleNext(this.currentIntervalMs);
    }
  }

  /**
   * Track NEXUS's own CPU cost and back off when it exceeds its budget. An
   * optimizer that spends 8% of a core watching an idle machine has already
   * lost more performance than most of its changes could win back.
   */
  private updateSelfUsage(): void {
    const now = this.clock.monotonic();
    const elapsed = this.lastCpuSampleMs === null ? 0 : now - this.lastCpuSampleMs;

    // A percentage computed over a few milliseconds is noise, not a
    // measurement: two samples taken back to back during startup would report
    // ~100% of a core and trigger a pointless back-off. Wait for a real
    // interval before drawing any conclusion.
    if (this.lastCpuUsage !== null && this.lastCpuSampleMs !== null && elapsed >= MIN_SELF_CPU_WINDOW_MS) {
      const delta = process.cpuUsage(this.lastCpuUsage);
      const wallMs = Math.max(1, elapsed);
      const cpuMs = (delta.user + delta.system) / 1000;
      this.selfCpuPercent = (cpuMs / wallMs) * 100;

      if (this.selfCpuPercent > this.selfCpuBudgetPercent && this.mode !== 'optimization') {
        const next = Math.min(8, this.backoffMultiplier * 1.5);
        if (next !== this.backoffMultiplier) {
          this.backoffMultiplier = next;
          this.logger.warn('reducing telemetry rate to stay inside the self CPU budget', {
            selfCpuPercent: Number(this.selfCpuPercent.toFixed(2)),
            budgetPercent: this.selfCpuBudgetPercent,
            intervalMs: this.currentIntervalMs,
          });
        }
      } else if (this.selfCpuPercent < this.selfCpuBudgetPercent * 0.5 && this.backoffMultiplier > 1) {
        this.backoffMultiplier = Math.max(1, this.backoffMultiplier / 1.5);
      }
    } else if (this.lastCpuUsage !== null && elapsed < MIN_SELF_CPU_WINDOW_MS) {
      // Keep the previous estimate and leave the sampling rate alone.
      return;
    }
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleMs = now;
  }

  /** Mode transitions with hysteresis and a dwell requirement. */
  private updateMode(snapshot: TelemetrySnapshot): void {
    if (this.mode === 'optimization' || this.mode === 'suspended') return;

    const activity = highestUtilisation(snapshot.readings);
    if (activity === null) return;

    const target: SamplingMode =
      this.mode === 'low_activity'
        ? activity >= this.activeEnter
          ? 'active_workload'
          : 'low_activity'
        : activity < this.activeExit
          ? 'low_activity'
          : 'active_workload';

    if (target === this.mode) {
      this.pendingMode = null;
      this.pendingCount = 0;
      return;
    }

    if (this.pendingMode === target) {
      this.pendingCount += 1;
    } else {
      this.pendingMode = target;
      this.pendingCount = 1;
    }

    if (this.pendingCount >= this.dwellSamples) {
      this.logger.debug('sampling mode change', { from: this.mode, to: target, activity });
      this.mode = target;
      this.pendingMode = null;
      this.pendingCount = 0;
    }
  }

  private recordSuccess(id: string, atMs: number): void {
    const current = this.health.get(id);
    if (!current) return;
    if (current.degraded) {
      this.logger.info('telemetry source recovered', { source: id });
    }
    this.health.set(id, {
      ...current,
      consecutiveFailures: 0,
      lastErrorMessage: null,
      lastSuccessMs: atMs,
      degraded: false,
    });
  }

  private recordFailure(id: string, error: unknown): void {
    const current = this.health.get(id);
    if (!current) return;
    const failures = current.consecutiveFailures + 1;
    const degraded = failures >= DEGRADED_AFTER_FAILURES;
    if (degraded && !current.degraded) {
      this.logger.warn('telemetry source degraded', { source: id, failures });
    }
    this.health.set(id, {
      ...current,
      consecutiveFailures: failures,
      lastErrorMessage: error instanceof Error ? error.message : String(error),
      degraded,
    });
  }
}

/**
 * When several sources report the same metric, keep the one with the strongest
 * fidelity, breaking ties on confidence. A live sensor always wins over a
 * mocked one for the same metric.
 */
function dedupeByMetric(readings: readonly Reading[]): Reading[] {
  const best = new Map<MetricId, Reading>();
  const rank: Record<Fidelity, number> = { unavailable: 0, mocked: 1, simulated: 2, unverified: 3, live: 4 };
  for (const r of readings) {
    const existing = best.get(r.metric);
    if (!existing) {
      best.set(r.metric, r);
      continue;
    }
    const better =
      (isKnown(r) ? 1 : 0) - (isKnown(existing) ? 1 : 0) ||
      rank[r.fidelity] - rank[existing.fidelity] ||
      r.confidence - existing.confidence;
    if (better > 0) best.set(r.metric, r);
  }
  return [...best.values()];
}

function highestUtilisation(readings: readonly Reading[]): number | null {
  let highest: number | null = null;
  for (const r of readings) {
    if (r.metric !== 'cpu.utilization' && r.metric !== 'gpu.utilization') continue;
    if (!isKnown(r)) continue;
    highest = highest === null ? r.value : Math.max(highest, r.value);
  }
  return highest;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`telemetry sample timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
