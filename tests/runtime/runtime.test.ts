import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FixedClock, systemClock } from '../../src/core/clock.js';
import { SequentialIds } from '../../src/core/ids.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { ScriptedCommandRunner } from '../../src/core/exec.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig, serializeConfig } from '../../src/config/config.js';
import type { NexusConfig } from '../../src/config/config.js';
import { NexusRuntime } from '../../src/runtime/runtime.js';
import { InstanceLock } from '../../src/runtime/instance-lock.js';
import { SessionStore } from '../../src/runtime/session-state.js';
import { StageTracker } from '../../src/runtime/stages.js';
import { OperationJournal } from '../../src/optimizer/journal.js';
import { CheckpointStore } from '../../src/checkpoint/store.js';
import { ActuatorRegistry, MockControlAdapter } from '../../src/optimizer/actuator.js';
import { EventLog } from '../../src/audit/eventlog.js';
import { recoverInterruptedOperations } from '../../src/runtime/recovery.js';

const logger = createLogger(new MemorySink(), 'error');
const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-rt-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function simulatedConfig(overrides: Partial<NexusConfig> = {}): NexusConfig {
  return {
    ...DEFAULT_CONFIG,
    simulate: { hardwareFixture: 'target-desktop', telemetry: true },
    ...overrides,
  };
}

async function makeRuntime(home: string, config: NexusConfig = simulatedConfig()): Promise<NexusRuntime> {
  return new NexusRuntime({
    paths: resolvePaths(home),
    config,
    clock: systemClock,
    logger,
    ids: new SequentialIds(),
    runner: new ScriptedCommandRunner(),
    platform: 'linux',
    wait: async () => undefined,
  });
}

describe('staged startup', () => {
  it('reports health while it is still initializing, and never claims ready early', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);

    const started = await runtime.start();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // start() returns before the slow stages finish.
    expect(started.value.runState).toBe('initializing');
    expect(started.value.stages.find((s) => s.stage === 'health')?.status).toBe('complete');

    await runtime.waitUntilInitialized();
    const health = runtime.health();
    expect(['ready', 'degraded', 'observation_only']).toContain(health.runState);
    expect(health.stages.every((s) => s.status !== 'running')).toBe(true);
    await runtime.shutdown('test');
  });

  it('answers every question the health contract requires', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();
    const health = runtime.health();

    expect(typeof health.runState).toBe('string');
    expect(typeof health.hardwareDetected).toBe('boolean');
    expect(typeof health.telemetryWorking).toBe('boolean');
    expect(health.capabilities.total).toBeGreaterThan(0);
    expect(health.activeProfileId).toBe('observation');
    expect(typeof health.optimizationEnabled).toBe('boolean');
    expect(health.previousShutdown).toBe('never_started');
    expect(typeof health.recoveryRequired).toBe('boolean');
    expect(health.vesperInterface.enabled).toBe(false);
    expect(health.selfFootprint.rssBytes).toBeGreaterThan(0);
    await runtime.shutdown('test');
  });

  it('stays in observation-only in observation mode', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();
    expect(runtime.currentRunState).toBe('observation_only');
    expect(runtime.health().optimizationEnabled).toBe(false);
    await runtime.shutdown('test');
  });

  it('refuses to change anything while in observation mode', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();
    const outcome = await runtime.runOptimization({ origin: 'user', requestedBy: 'test' });
    expect(outcome.status).toBe('no_action');
    expect(outcome.noActionReason).toBe('observation_only');
    await runtime.shutdown('test');
  });

  it('does not act on its own initiative in assisted mode', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home, simulatedConfig({ mode: 'assisted' }));
    await runtime.start();
    await runtime.waitUntilInitialized();
    const outcome = await runtime.runOptimization({ origin: 'internal', requestedBy: 'nexus' });
    expect(outcome.status).toBe('no_action');
    await runtime.shutdown('test');
  });

  it('discovers the simulated target machine and labels it mocked throughout', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();

    const inventory = runtime.inventorySnapshot;
    expect(inventory?.cpu.model).toContain('9950X');
    expect(inventory?.gpus[0]?.vramBytes).toBe(20 * 1024 ** 3);
    expect(inventory?.memory.installedBytes).toBe(96 * 1024 ** 3);
    expect(inventory?.fidelity).toBe('mocked');

    // Nothing derived from a fixture may be reported as live.
    for (const record of runtime.capabilityRegistry.list()) {
      if (record.state === 'available') expect(record.fidelity).toBe('live');
      if (record.fidelity === 'live') expect(record.state).not.toBe('mocked');
    }
    await runtime.shutdown('test');
  });
});

describe('single instance', () => {
  it('refuses a second instance on the same home', async () => {
    const home = await tempHome();
    const first = await makeRuntime(home);
    const started = await first.start();
    expect(started.ok).toBe(true);

    const second = await makeRuntime(home);
    const blocked = await second.start();
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.code).toBe('E_CONFLICT');

    await first.shutdown('test');
  });

  it('lets a new instance start after the first releases the lock', async () => {
    const home = await tempHome();
    const first = await makeRuntime(home);
    await first.start();
    await first.shutdown('test');

    const second = await makeRuntime(home);
    const started = await second.start();
    expect(started.ok).toBe(true);
    await second.shutdown('test');
  });

  it('reclaims a stale socket left by a crashed process', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const lock = new InstanceLock({
      paths,
      clock: new FixedClock(),
      logger,
      sessionId: 's1',
      nexusVersion: '0.1.0',
      platform: 'linux',
    });
    const acquired = await lock.acquire();
    expect(acquired.ok).toBe(true);

    // Simulate a crash: the socket file survives but nothing is listening.
    await lock.release();
    await writeFile(lock.endpoint, '', 'utf8').catch(() => undefined);

    const second = new InstanceLock({
      paths,
      clock: new FixedClock(),
      logger,
      sessionId: 's2',
      nexusVersion: '0.1.0',
      platform: 'linux',
    });
    const reacquired = await second.acquire();
    expect(reacquired.ok).toBe(true);
    await second.release();
  });

  it('names the holder when it refuses', async () => {
    const home = await tempHome();
    const first = await makeRuntime(home);
    await first.start();

    const second = await makeRuntime(home);
    const blocked = await second.start();
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.error.message).toMatch(/already running/);
    await first.shutdown('test');
  });
});

describe('session state and the restart guard', () => {
  it('detects an unclean previous shutdown', async () => {
    const home = await tempHome();
    const first = await makeRuntime(home);
    await first.start();
    // No shutdown call: the session record stays cleanShutdown:false.
    await (first as unknown as { lock: InstanceLock }).lock.release();

    const second = await makeRuntime(home);
    await second.start();
    expect(second.previousSessionShutdown).toBe('crash');
    await second.shutdown('test');
  });

  it('records a clean shutdown', async () => {
    const home = await tempHome();
    const first = await makeRuntime(home);
    await first.start();
    await first.shutdown('test');

    const second = await makeRuntime(home);
    await second.start();
    expect(second.previousSessionShutdown).toBe('clean');
    await second.shutdown('test');
  });

  it('drops to observation-only after repeated restarts', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const clock = new FixedClock();
    const store = new SessionStore({
      paths,
      clock,
      sessionId: 's',
      nexusVersion: '0.1.0',
      maxStartsInWindow: 3,
      restartWindowMs: 60_000,
    });
    for (let i = 0; i < 3; i += 1) {
      const begun = await store.begin();
      expect(begun.ok && begun.value.restart.looping).toBe(false);
      clock.advance(1000);
    }
    const looping = await store.begin();
    expect(looping.ok).toBe(true);
    if (!looping.ok) return;
    expect(looping.value.restart.looping).toBe(true);
    expect(looping.value.restart.reason).toContain('observation-only');
  });

  it('forgets restarts outside the window', async () => {
    const home = await tempHome();
    const clock = new FixedClock();
    const store = new SessionStore({
      paths: resolvePaths(home),
      clock,
      sessionId: 's',
      nexusVersion: '0.1.0',
      maxStartsInWindow: 2,
      restartWindowMs: 10_000,
    });
    await store.begin();
    await store.begin();
    clock.advance(60_000);
    const later = await store.begin();
    expect(later.ok && later.value.restart.looping).toBe(false);
  });
});

describe('crash recovery', () => {
  async function recoveryFixture(status: 'intent' | 'applying') {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const clock = new FixedClock();
    const registry = new ActuatorRegistry();
    const adapter = new MockControlAdapter('power.processor.min_state', { initial: 5 });
    registry.register(adapter);

    const checkpoints = new CheckpointStore({
      paths,
      clock,
      logger,
      ids: new SequentialIds(),
      sessionId: 'old',
      registry,
    });
    const journal = new OperationJournal(paths, clock, 'old');
    const eventLog = new EventLog({ paths, clock, logger, sessionId: 'new' });
    await eventLog.open();
    const context = { clock, logger, runner: new ScriptedCommandRunner(), timeoutMs: 1000 };

    const checkpoint = await checkpoints.capture(['power.processor.min_state'], 'test', context);
    if (!checkpoint.ok) throw checkpoint.error;

    const record = await journal.record('op_1', 'prop_1', ['power.processor.min_state']);
    if (!record.ok) throw record.error;

    if (status === 'applying') {
      await adapter.write(context, 40);
      await journal.advance(record.value, 'applying', 'mid-flight', {
        checkpointId: checkpoint.value.id,
        appliedControls: ['power.processor.min_state'],
      });
    } else {
      await journal.advance(record.value, 'intent', 'not started', { checkpointId: checkpoint.value.id });
    }

    return { adapter, journal, checkpoints, eventLog, context };
  }

  it('abandons an operation interrupted before any write', async () => {
    const f = await recoveryFixture('intent');
    const outcome = await recoverInterruptedOperations({ ...f, logger });
    expect(outcome.required).toBe(true);
    expect(outcome.actions[0]?.action).toBe('abandoned');
    expect(outcome.unresolved).toBe(false);
    expect(f.adapter.current).toBe(5);
  });

  it('rolls back an operation interrupted mid-apply', async () => {
    const f = await recoveryFixture('applying');
    expect(f.adapter.current).toBe(40);
    const outcome = await recoverInterruptedOperations({ ...f, logger });
    expect(outcome.actions[0]?.action).toBe('rolled_back');
    expect(outcome.unresolved).toBe(false);
    expect(f.adapter.current).toBe(5);
  });

  it('never assumes an interrupted operation succeeded', async () => {
    const f = await recoveryFixture('applying');
    await recoverInterruptedOperations({ ...f, logger });
    const records = await f.journal.list();
    expect(records[0]?.status).not.toBe('committed');
  });

  it('reports unresolved when it cannot restore', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const clock = new FixedClock();
    const registry = new ActuatorRegistry();
    const journal = new OperationJournal(paths, clock, 'old');
    const checkpoints = new CheckpointStore({
      paths, clock, logger, ids: new SequentialIds(), sessionId: 'old', registry,
    });
    const eventLog = new EventLog({ paths, clock, logger, sessionId: 'new' });
    await eventLog.open();
    const context = { clock, logger, runner: new ScriptedCommandRunner(), timeoutMs: 1000 };

    const record = await journal.record('op_x', 'prop_x', ['power.processor.min_state']);
    if (!record.ok) throw record.error;
    // Mid-apply with no checkpoint at all: the prior values are simply unknown.
    await journal.advance(record.value, 'applied', 'no checkpoint', {
      appliedControls: ['power.processor.min_state'],
    });

    const outcome = await recoverInterruptedOperations({ journal, checkpoints, eventLog, logger, context });
    expect(outcome.unresolved).toBe(true);
    expect(outcome.actions[0]?.action).toBe('no_checkpoint');
    expect(outcome.summary).toContain('observation-only');
  });

  it('runs recovery during startup and reports it in health', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const journal = new OperationJournal(paths, new FixedClock(), 'old');
    const record = await journal.record('op_prev', 'prop_prev', ['power.processor.min_state']);
    if (!record.ok) throw record.error;

    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();
    const health = runtime.health();
    expect(health.recoveryRequired).toBe(true);
    await runtime.shutdown('test');
  });
});

describe('graceful shutdown', () => {
  it('completes and marks the session clean', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();
    await runtime.shutdown('test');

    expect(runtime.currentRunState).toBe('stopped');
    const session = JSON.parse(
      await readFile(path.join(resolvePaths(home).state, 'session.json'), 'utf8'),
    ) as { cleanShutdown: boolean };
    expect(session.cleanShutdown).toBe(true);
  });

  it('is idempotent', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.shutdown('first');
    await runtime.shutdown('second');
    expect(runtime.currentRunState).toBe('stopped');
  });

  it('writes a session-end event', async () => {
    const home = await tempHome();
    const runtime = await makeRuntime(home);
    await runtime.start();
    await runtime.waitUntilInitialized();
    await runtime.shutdown('test');

    const events = await runtime.auditLog.readAll();
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => e.kind)).toContain('session.end');
    const verified = await runtime.auditLog.verify();
    expect(verified.ok && verified.value.valid).toBe(true);
  });
});

describe('StageTracker', () => {
  it('records a failure without throwing', async () => {
    const tracker = new StageTracker(new FixedClock());
    const ok = await tracker.run('telemetry', async () => {
      throw new Error('sensor missing');
    });
    expect(ok).toBe(false);
    expect(tracker.status('telemetry')).toBe('failed');
    expect(tracker.failed()).toContain('telemetry');
    expect(tracker.requiredComplete()).toBe(false);
  });
});

describe('configuration', () => {
  it('round-trips through disk', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    const config: NexusConfig = { ...DEFAULT_CONFIG, mode: 'autonomous' };
    const saved = await saveConfig(paths, config);
    expect(saved.ok).toBe(true);

    const loaded = await loadConfig(paths);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.mode).toBe('autonomous');
    expect(loaded.value.simulate.hardwareFixture).toBeNull();
  });

  it('omits absent values rather than writing null', () => {
    const serialized = serializeConfig(DEFAULT_CONFIG) as { simulate: Record<string, unknown> };
    expect('hardwareFixture' in serialized.simulate).toBe(false);
  });

  it('defaults to observation mode', async () => {
    const home = await tempHome();
    const loaded = await loadConfig(resolvePaths(home));
    expect(loaded.ok && loaded.value.mode).toBe('observation');
  });

  it('rejects a config file with an unknown field', async () => {
    const home = await tempHome();
    const paths = resolvePaths(home);
    await rm(paths.home, { recursive: true, force: true }).catch(() => undefined);
    await mkdtemp(path.join(tmpdir(), 'x-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(paths.home, { recursive: true });
    await writeFile(path.join(paths.home, 'config.json'), JSON.stringify({ mode: 'autonomous', bypassSafety: true }));
    const loaded = await loadConfig(paths);
    expect(loaded.ok).toBe(false);
  });
});
