/**
 * Startup stage tracking.
 *
 * Health has to be answerable while startup is still in progress, so the stage
 * table is maintained as a plain, synchronously readable structure. During
 * initialization NEXUS reports `initializing` and says exactly which stages
 * are done — it never reports "ready" because the process exists.
 */

import type { Clock } from '../core/clock.js';
import type { InitStage, StageReport, StageStatus } from '../domain/health.js';
import { INIT_STAGES } from '../domain/health.js';

export class StageTracker {
  private readonly clock: Clock;
  private readonly reports = new Map<InitStage, StageReport>();

  constructor(clock: Clock) {
    this.clock = clock;
    for (const stage of INIT_STAGES) {
      this.reports.set(stage, {
        stage,
        status: 'pending',
        startedAtMs: null,
        finishedAtMs: null,
        detail: null,
      });
    }
  }

  begin(stage: InitStage): void {
    this.reports.set(stage, {
      stage,
      status: 'running',
      startedAtMs: this.clock.now(),
      finishedAtMs: null,
      detail: null,
    });
  }

  finish(stage: InitStage, status: Exclude<StageStatus, 'pending' | 'running'>, detail: string | null = null): void {
    const current = this.reports.get(stage);
    this.reports.set(stage, {
      stage,
      status,
      startedAtMs: current?.startedAtMs ?? this.clock.now(),
      finishedAtMs: this.clock.now(),
      detail,
    });
  }

  status(stage: InitStage): StageStatus {
    return this.reports.get(stage)?.status ?? 'pending';
  }

  all(): readonly StageReport[] {
    return INIT_STAGES.map((stage) => this.reports.get(stage)).filter((r): r is StageReport => r !== undefined);
  }

  /** Stages that must complete before optimization may run. */
  requiredComplete(): boolean {
    const required: readonly InitStage[] = ['core', 'health', 'audit', 'recovery', 'telemetry', 'hardware', 'capabilities', 'profiles', 'baseline', 'optimizer'];
    return required.every((stage) => this.status(stage) === 'complete');
  }

  failed(): readonly InitStage[] {
    return this.all().filter((r) => r.status === 'failed').map((r) => r.stage);
  }

  /** Run a stage, recording success or failure and never throwing. */
  async run(stage: InitStage, fn: () => Promise<string | null>): Promise<boolean> {
    this.begin(stage);
    try {
      const detail = await fn();
      this.finish(stage, 'complete', detail);
      return true;
    } catch (e) {
      this.finish(stage, 'failed', e instanceof Error ? e.message : String(e));
      return false;
    }
  }
}
