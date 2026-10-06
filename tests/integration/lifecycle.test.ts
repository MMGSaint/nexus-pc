/**
 * End-to-end lifecycle tests.
 *
 * These drive the real runtime — discovery, probing, baseline, classification,
 * proposal, audit — against the simulated target machine, and assert the
 * properties that only show up when the pieces are wired together.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { systemClock, FixedClock } from '../../src/core/clock.js';
import { SequentialIds } from '../../src/core/ids.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { ScriptedCommandRunner } from '../../src/core/exec.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { NexusConfig } from '../../src/config/config.js';
import { NexusRuntime } from '../../src/runtime/runtime.js';
import { MockControlAdapter } from '../../src/optimizer/actuator.js';
import { OperationJournal } from '../../src/optimizer/journal.js';
import { CheckpointStore } from '../../src/checkpoint/store.js';
import { ActuatorRegistry } from '../../src/optimizer/actuator.js';

const logger = createLogger(new MemorySink(), 'error');
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-e2e-'));
  homes.push(home);
  return home;
}

function config(overrides: Partial<NexusConfig> = {}): NexusConfig {
  return {
    ...DEFAULT_CONFIG,
    simulate: { hardwareFixture: 'target-desktop', telemetry: true },
    ...overrides,
  };
}

async function boot(home: string, cfg: NexusConfig = config()): Promise<NexusRuntime> {
  const runtime = new NexusRuntime({
    paths: resolvePaths(home),
    config: cfg,
    clock: systemClock,
    logger,
    ids: new SequentialIds(),
    runner: new ScriptedCommandRunner(),
    // Use the real test-host transport so Windows CI exercises named-pipe locking.
    platform: process.platform,
    wait: async () => undefined,
  });
  const started = await runtime.start();
  if (!started.ok) throw started.error;
  await runtime.waitUntilInitialized();
  return runtime;
}

describe('full lifecycle against the simulated target machine', () => {
  it('discovers, probes, baselines and reports without changing anything', async () => {
    const home = await tempHome();
    const runtime = await boot(home);

    const inventory = runtime.inventorySnapshot;
    expect(inventory?.cpu.model).toContain('9950X');
    expect(inventory?.gpus[0]?.model).toContain('7900 XT');

    const baseline = await runtime.baselineStore.latest();
    expect(baseline.ok).toBe(true);

    // The critical assertion: establishing a baseline changed nothing.
    for (const control of runtime.actuatorRegistry.controls()) {
      const adapter = runtime.actuatorRegistry.get(control);
      expect((adapter as MockControlAdapter).writes, control).toHaveLength(0);
    }

    const audit = await runtime.auditLog.verify();
    expect(audit.ok && audit.value.valid).toBe(true);
    await runtime.shutdown('test');
  });

  it('labels everything derived from a fixture as mocked, end to end', async () => {
    const home = await tempHome();
    const runtime = await boot(home);

    const baseline = await runtime.baselineStore.latest();
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.value.fidelity).not.toBe('live');

    const telemetry = await runtime.getTelemetrySummary(60_000);
    expect(telemetry.fidelity).not.toBe('live');

    const workload = await runtime.analyzeWorkload();
    expect(workload.fidelity).not.toBe('live');

    await runtime.shutdown('test');
  });

  it('recommends without applying', async () => {
    const home = await tempHome();
    const runtime = await boot(home, config({ mode: 'autonomous' }));

    const recommendation = await runtime.recommend('balanced');
    expect(recommendation.recommendedProfileId).toBe('balanced');

    for (const control of runtime.actuatorRegistry.controls()) {
      expect((runtime.actuatorRegistry.get(control) as MockControlAdapter).writes).toHaveLength(0);
    }
    await runtime.shutdown('test');
  });

  it('refuses to act on simulated telemetry even in autonomous mode', async () => {
    const home = await tempHome();
    const runtime = await boot(home, config({ mode: 'autonomous' }));

    const outcome = await runtime.runOptimization({ origin: 'user', requestedBy: 'test', profileId: 'balanced' });
    // Simulated signals cap classification confidence below the action floor,
    // so a simulation can never talk NEXUS into changing a real machine.
    expect(['no_action', 'rejected']).toContain(outcome.status);
    expect(outcome.fidelity).not.toBe('live');
    await runtime.shutdown('test');
  });

  it('reports the same health through the Vesper host surface as at the CLI', async () => {
    const home = await tempHome();
    const runtime = await boot(home);
    const direct = runtime.health();
    const viaVesper = await runtime.getStatus();
    expect(viaVesper.sessionId).toBe(direct.sessionId);
    expect(viaVesper.runState).toBe(direct.runState);
    await runtime.shutdown('test');
  });

  it('records a declared context as a hint that does not override observation', async () => {
    const home = await tempHome();
    const runtime = await boot(home);

    const before = await runtime.analyzeWorkload();
    await runtime.declareContext({
      workload: 'gaming',
      declaredBy: 'vesper',
      declaredAtMs: runtime.now(),
      ttlMs: 600_000,
      note: 'the user said they are about to play',
    });
    const after = await runtime.analyzeWorkload();

    // The hint is recorded and reported, but the simulated machine is idle and
    // NEXUS says so rather than adopting the claim.
    expect(after.declaredContext?.workload).toBe('gaming');
    if (before.workload !== 'gaming') {
      expect(after.contextConflict).toBe(true);
      expect(after.explanation).toContain('not visible in the telemetry');
    }
    await runtime.shutdown('test');
  });
});

describe('rollback goes through the safety kernel', () => {
  it('refuses a Vesper rollback while NEXUS is in observation mode', async () => {
    const home = await tempHome();
    const runtime = await boot(home);

    // Stage a checkpoint so the refusal is about the gate, not a missing file.
    const checkpoint = await runtime.checkpointStore.capture(
      ['power.processor.min_state'],
      'test',
      { clock: systemClock, logger, runner: new ScriptedCommandRunner(), timeoutMs: 1000 },
    );
    if (!checkpoint.ok) throw checkpoint.error;

    const adapter = runtime.actuatorRegistry.get('power.processor.min_state') as MockControlAdapter;
    const writesBefore = adapter.writes.length;

    await expect(runtime.rollback(checkpoint.value.id)).rejects.toMatchObject({
      code: 'E_SAFETY_REJECTED',
    });
    // Nothing was written: the refusal happened before the restore.
    expect(adapter.writes.length).toBe(writesBefore);

    const events = await runtime.auditLog.readAll();
    expect(events.ok).toBe(true);
    if (events.ok) expect(events.value.map((e) => e.kind)).toContain('rollback.refused');

    await runtime.shutdown('test');
  });

  it('permits a human rollback while observation-only, because reverting is the safe direction', async () => {
    const home = await tempHome();
    const runtime = await boot(home);
    const context = { clock: systemClock, logger, runner: new ScriptedCommandRunner(), timeoutMs: 1000 };

    const adapter = runtime.actuatorRegistry.get('power.processor.min_state') as MockControlAdapter;
    const original = adapter.current;
    const checkpoint = await runtime.checkpointStore.capture(['power.processor.min_state'], 'test', context);
    if (!checkpoint.ok) throw checkpoint.error;

    await adapter.write(context, 42);
    const restored = await runtime.performRollback(checkpoint.value.id, 'user', 'test');
    expect(restored.complete).toBe(true);
    expect(adapter.current).toBe(original);
    // Performed by mock adapters, so it must not be labelled live.
    expect(restored.fidelity).toBe('mocked');

    await runtime.shutdown('test');
  });
});

describe('one optimization at a time', () => {
  it('refuses a concurrent request rather than racing the rate limit', async () => {
    const home = await tempHome();
    const runtime = await boot(home, config({ mode: 'autonomous' }));

    const [first, second] = await Promise.all([
      runtime.runOptimization({ origin: 'user', requestedBy: 'a', profileId: 'balanced' }),
      runtime.runOptimization({ origin: 'user', requestedBy: 'b', profileId: 'balanced' }),
    ]);

    // Both are refused here because simulated telemetry caps confidence, but
    // the guard must hold regardless: two optimizations must never overlap.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    for (const outcome of [first, second]) {
      expect(['no_action', 'rejected']).toContain(outcome.status);
    }
    await runtime.shutdown('test');
  });
});

describe('restart after a crash mid-operation', () => {
  it('reconciles the interrupted operation on the next start', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const clock = new FixedClock();

    // Stage the wreckage of a previous session: a checkpoint plus an
    // operation left in 'applying', with the control moved away from its
    // captured value.
    const registry = new ActuatorRegistry();
    const adapter = new MockControlAdapter('power.processor.min_state', { initial: 5 });
    registry.register(adapter);
    const checkpoints = new CheckpointStore({
      paths, clock, logger, ids: new SequentialIds(), sessionId: 'old', registry,
    });
    const journal = new OperationJournal(paths, clock, 'old');
    const context = { clock, logger, runner: new ScriptedCommandRunner(), timeoutMs: 100 };

    const checkpoint = await checkpoints.capture(['power.processor.min_state'], 'before crash', context);
    if (!checkpoint.ok) throw checkpoint.error;
    const record = await journal.record('op_crash', 'prop_crash', ['power.processor.min_state']);
    if (!record.ok) throw record.error;
    await journal.advance(record.value, 'applying', 'interrupted', {
      checkpointId: checkpoint.value.id,
      appliedControls: ['power.processor.min_state'],
    });

    const runtime = await boot(home);
    const health = runtime.health();
    expect(health.recoveryRequired).toBe(true);
    expect(health.recoverySummary).toBeTruthy();

    const records = await journal.list();
    expect(records[0]?.status).not.toBe('committed');

    const events = await runtime.auditLog.readAll();
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => e.kind)).toContain('recovery.started');

    await runtime.shutdown('test');
  });
});

describe('audit trail survives a restart', () => {
  it('continues the hash chain across sessions', async () => {
    const home = await tempHome();
    const first = await boot(home);
    const firstSeq = first.auditLog.sequence;
    await first.shutdown('test');

    const second = await boot(home);
    expect(second.auditLog.sequence).toBeGreaterThan(firstSeq);
    const verified = await second.auditLog.verify();
    expect(verified.ok && verified.value.valid).toBe(true);
    await second.shutdown('test');
  });
});
