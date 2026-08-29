import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FixedClock } from '../../src/core/clock.js';
import { ScriptedCommandRunner } from '../../src/core/exec.js';
import { SequentialIds } from '../../src/core/ids.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import type { NexusPaths } from '../../src/core/paths.js';
import { EventLog } from '../../src/audit/eventlog.js';
import { CheckpointStore } from '../../src/checkpoint/store.js';
import { ActuatorRegistry, MockControlAdapter } from '../../src/optimizer/actuator.js';
import type { ActuatorContext } from '../../src/optimizer/actuator.js';
import { OperationJournal } from '../../src/optimizer/journal.js';
import { OptimizationEngine } from '../../src/optimizer/engine.js';
import type { ExecutionEnvironment } from '../../src/optimizer/engine.js';
import { SafetyKernel } from '../../src/safety/kernel.js';
import { BASE_POLICY } from '../../src/safety/policy.js';
import type { TelemetrySummary } from '../../src/domain/telemetry.js';
import type { WorkloadClassification } from '../../src/domain/workload.js';
import { ALL_POWER_CAPS, capabilityMap, telemetrySnapshot, T0 } from './factories.js';

export interface Harness {
  readonly home: string;
  readonly paths: NexusPaths;
  readonly clock: FixedClock;
  readonly registry: ActuatorRegistry;
  readonly engine: OptimizationEngine;
  readonly journal: OperationJournal;
  readonly checkpoints: CheckpointStore;
  readonly eventLog: EventLog;
  readonly actuatorContext: ActuatorContext;
  readonly logSink: MemorySink;
  cleanup(): Promise<void>;
}

export async function makeHarness(
  options: { kernel?: SafetyKernel } = {},
): Promise<Harness> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-engine-'));
  const paths = resolvePaths(home);
  const clock = new FixedClock(T0);
  const logSink = new MemorySink();
  const logger = createLogger(logSink, 'debug');
  const ids = new SequentialIds();
  const registry = new ActuatorRegistry();

  const eventLog = new EventLog({ paths, clock, logger, sessionId: 'sess_test' });
  await eventLog.open();

  const checkpoints = new CheckpointStore({
    paths,
    clock,
    logger,
    ids,
    sessionId: 'sess_test',
    registry,
  });
  const journal = new OperationJournal(paths, clock, 'sess_test');

  const engine = new OptimizationEngine({
    clock,
    logger,
    ids,
    kernel: options.kernel ?? new SafetyKernel(BASE_POLICY),
    registry,
    checkpoints,
    journal,
    eventLog,
    // Tests must not spend the real measurement window waiting.
    wait: async () => undefined,
  });

  return {
    home,
    paths,
    clock,
    registry,
    engine,
    journal,
    checkpoints,
    eventLog,
    logSink,
    actuatorContext: {
      clock,
      logger,
      runner: new ScriptedCommandRunner(),
      timeoutMs: 1000,
    },
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

export function registerPowerAdapters(registry: ActuatorRegistry): {
  min: MockControlAdapter;
  max: MockControlAdapter;
} {
  const min = new MockControlAdapter('power.processor.min_state', { initial: 5 });
  const max = new MockControlAdapter('power.processor.max_state', { initial: 100 });
  registry.register(min);
  registry.register(max);
  return { min, max };
}

export function classification(overrides: Partial<WorkloadClassification> = {}): WorkloadClassification {
  return {
    timestampMs: T0,
    workload: 'gaming',
    confidence: 0.85,
    candidates: [],
    fidelity: 'live',
    missingSignals: [],
    contextConflict: false,
    explanation: 'test classification',
    ...overrides,
  };
}

export function summary(values: Record<string, number>, sampleCount = 10): TelemetrySummary {
  return {
    fromMs: T0,
    toMs: T0 + 10_000,
    sampleCount,
    fidelity: 'live',
    metrics: Object.entries(values).map(([metric, mean]) => ({
      metric: metric as never,
      unit: 'percent' as const,
      samples: sampleCount,
      min: mean,
      max: mean,
      mean,
      p95: mean,
      last: mean,
      fidelity: 'live' as const,
      coverage: 1,
    })),
  };
}

export function environment(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return {
    runState: 'ready',
    capabilities: capabilityMap(ALL_POWER_CAPS),
    telemetry: telemetrySnapshot(),
    baselineAvailable: true,
    recentApplications: [],
    workload: classification(),
    beforeSummary: summary({ 'cpu.utilization': 50, 'cpu.temperature': 60 }),
    measureAfter: async () => summary({ 'cpu.utilization': 50, 'cpu.temperature': 60 }),
    ...overrides,
  };
}
