import { afterEach, describe, expect, it } from 'vitest';

import { change, proposal } from '../helpers/factories.js';
import {
  classification,
  environment,
  makeHarness,
  registerPowerAdapters,
  summary,
  type Harness,
} from '../helpers/engine-harness.js';
import { MockControlAdapter } from '../../src/optimizer/actuator.js';
import { nexusError } from '../../src/core/errors.js';
import { findBuiltinProfile } from '../../src/profiles/builtin.js';
import { SafetyKernel } from '../../src/safety/kernel.js';
import { BASE_POLICY, narrowPolicy } from '../../src/safety/policy.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

describe('propose', () => {
  it('builds a proposal from the difference between profile and current state', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    const profile = findBuiltinProfile('gaming');
    if (!profile) throw new Error('missing builtin profile');

    const result = harness.engine.propose({
      workload: classification(),
      profile,
      currentValues: new Map([
        ['power.processor.min_state', 5],
        ['power.processor.max_state', 100],
      ]),
      origin: 'internal',
      requestedBy: 'test',
    });

    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') return;
    // max_state already matches, so only min_state is proposed. core_parking
    // and boost_mode have no adapter registered and are skipped.
    expect(result.proposal.changes.map((c) => c.control)).toEqual(['power.processor.min_state']);
  });

  it('returns already_optimal when nothing needs to change', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    const profile = findBuiltinProfile('gaming');
    if (!profile) throw new Error('missing builtin profile');

    const result = harness.engine.propose({
      workload: classification(),
      profile,
      currentValues: new Map([
        ['power.processor.min_state', 20],
        ['power.processor.max_state', 100],
      ]),
      origin: 'internal',
      requestedBy: 'test',
    });

    expect(result.kind).toBe('no_action');
    if (result.kind !== 'no_action') return;
    expect(result.reason).toBe('already_optimal');
    expect(result.summary).toContain('No change is required');
  });

  it('refuses to act on a low-confidence classification', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    const profile = findBuiltinProfile('gaming');
    if (!profile) throw new Error('missing builtin profile');

    const result = harness.engine.propose({
      workload: classification({ confidence: 0.3 }),
      profile,
      currentValues: new Map(),
      origin: 'internal',
      requestedBy: 'test',
    });
    expect(result.kind).toBe('no_action');
    if (result.kind !== 'no_action') return;
    expect(result.reason).toBe('low_confidence');
  });

  it('refuses to act on an unknown workload', async () => {
    harness = await makeHarness();
    const profile = findBuiltinProfile('gaming');
    if (!profile) throw new Error('missing builtin profile');
    const result = harness.engine.propose({
      workload: classification({ workload: 'unknown', confidence: 0.9 }),
      profile,
      currentValues: new Map(),
      origin: 'internal',
      requestedBy: 'test',
    });
    expect(result.kind).toBe('no_action');
  });
});

describe('execute — refusal paths', () => {
  it('returns rejected when the safety kernel refuses', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    const result = await harness.engine.execute(
      proposal({ changes: [change('power.processor.max_state', 10)] }),
      environment(),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
    expect(result.value.appliedChanges).toHaveLength(0);
    expect(await harness.journal.list()).toHaveLength(0);
  });

  it('returns requires_confirmation without touching anything', async () => {
    harness = await makeHarness();
    const adapter = new MockControlAdapter('os.game_mode', { initial: false });
    harness.registry.register(adapter);
    const result = await harness.engine.execute(
      proposal({ origin: 'user', changes: [change('os.game_mode', true)] }),
      environment(),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('requires_confirmation');
    expect(adapter.writes).toHaveLength(0);
  });

  it('refuses to apply when the prior value cannot be captured', async () => {
    harness = await makeHarness();
    const adapter = new MockControlAdapter('power.processor.min_state', { initial: 5, readFails: true });
    harness.registry.register(adapter);

    const result = await harness.engine.execute(proposal(), environment(), harness.actuatorContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('no_action');
    expect(result.value.noActionReason).toBe('unsafe');
    expect(result.value.summary).toContain('could not be reversed');
    expect(adapter.writes).toHaveLength(0);
  });

  it('refuses every write when the policy is observation-only', async () => {
    harness = await makeHarness({
      kernel: new SafetyKernel(narrowPolicy(BASE_POLICY, { global: { observationOnly: true } }).policy),
    });
    const { min } = registerPowerAdapters(harness.registry);
    const result = await harness.engine.execute(proposal(), environment(), harness.actuatorContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('rejected');
    expect(min.writes).toHaveLength(0);
  });
});

describe('execute — apply and keep', () => {
  it('applies, measures and keeps a change with no regression', async () => {
    harness = await makeHarness();
    const { min } = registerPowerAdapters(harness.registry);

    const result = await harness.engine.execute(proposal(), environment(), harness.actuatorContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_kept');
    expect(min.current).toBe(20);
    expect(result.value.appliedChanges[0]?.previousValue).toBe(5);
    expect(result.value.appliedChanges[0]?.verified).toBe(true);

    const operations = await harness.journal.list();
    expect(operations[0]?.status).toBe('committed');
  });

  it('reports a measured improvement distinctly from no measurable benefit', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);

    const improved = await harness.engine.execute(
      proposal(),
      environment({
        beforeSummary: summary({ 'cpu.utilization': 80 }),
        measureAfter: async () => summary({ 'cpu.utilization': 50 }),
      }),
      harness.actuatorContext,
    );
    expect(improved.ok && improved.value.summary).toContain('measured an improvement');

    harness.clock.advance(10 * 60 * 1000);
    const flat = await harness.engine.execute(
      proposal(),
      environment({
        beforeSummary: summary({ 'cpu.utilization': 50 }),
        measureAfter: async () => summary({ 'cpu.utilization': 50 }),
      }),
      harness.actuatorContext,
    );
    expect(flat.ok && flat.value.summary).toContain('no improvement was measurable');
  });

  it('labels the outcome mocked when the actuator is a mock', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    const result = await harness.engine.execute(proposal(), environment(), harness.actuatorContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fidelity).toBe('mocked');
    expect(result.value.fidelity).not.toBe('live');
  });
});

describe('execute — rollback paths', () => {
  it('rolls back when a thermal regression is measured', async () => {
    harness = await makeHarness();
    const { min } = registerPowerAdapters(harness.registry);

    const result = await harness.engine.execute(
      proposal(),
      environment({
        beforeSummary: summary({ 'cpu.temperature': 60 }),
        measureAfter: async () => summary({ 'cpu.temperature': 75 }),
      }),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_rolled_back');
    expect(result.value.rolledBack).toBe(true);
    expect(min.current).toBe(5);
    expect(result.value.summary).toContain('regression was measured');
    expect((await harness.journal.list())[0]?.status).toBe('rolled_back');
  });

  it('rolls back when the effect cannot be measured at all', async () => {
    harness = await makeHarness();
    const { min } = registerPowerAdapters(harness.registry);
    const result = await harness.engine.execute(
      proposal(),
      environment({ measureAfter: async () => summary({}, 0) }),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_rolled_back');
    expect(result.value.summary).toContain('could not be measured');
    expect(min.current).toBe(5);
  });

  it('rolls back a change with no benefit under the unless_benefit policy', async () => {
    harness = await makeHarness();
    const { min } = registerPowerAdapters(harness.registry);
    const result = await harness.engine.execute(
      proposal(),
      environment({ rollbackPolicy: 'unless_benefit' }),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_rolled_back');
    expect(min.current).toBe(5);
  });

  it('rolls back when a write is silently ignored', async () => {
    harness = await makeHarness();
    const adapter = new MockControlAdapter('power.processor.min_state', {
      initial: 5,
      writeSilentlyIgnored: true,
    });
    harness.registry.register(adapter);

    const result = await harness.engine.execute(proposal(), environment(), harness.actuatorContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_rolled_back');
    expect(result.value.summary).toContain('could not be applied cleanly');
  });

  it('only rolls back the controls it actually wrote', async () => {
    harness = await makeHarness();
    const min = new MockControlAdapter('power.processor.min_state', { initial: 5 });
    const parking = new MockControlAdapter('power.processor.core_parking_min', { initial: 10, writeFails: true });
    harness.registry.register(min);
    harness.registry.register(parking);

    const result = await harness.engine.execute(
      proposal({
        changes: [change('power.processor.min_state', 20), change('power.processor.core_parking_min', 100)],
      }),
      environment(),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_rolled_back');
    expect(min.current).toBe(5);
    expect(parking.current).toBe(10);
  });

  it('reverts a write that landed even though it reported failure', async () => {
    harness = await makeHarness();
    const adapter = new LandsThenFailsAdapter();
    harness.registry.register(adapter);

    const result = await harness.engine.execute(proposal(), environment(), harness.actuatorContext);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The write changed the machine before erroring, so it must be reverted
    // and must not be described as having changed nothing.
    expect(adapter.current).toBe(5);
    expect(result.value.summary).not.toContain('Nothing had been changed');
    expect(result.value.status).toBe('applied_rolled_back');
  });

  it('journals a control before writing it, so a crash mid-write is recoverable', async () => {
    harness = await makeHarness();
    const { min } = registerPowerAdapters(harness.registry);
    void min;
    await harness.engine.execute(proposal(), environment(), harness.actuatorContext);

    const operations = await harness.journal.list();
    // The terminal record still carries the control, which is what recovery
    // reads to decide what to put back.
    expect(operations[0]?.appliedControls).toContain('power.processor.min_state');
  });

  it('reports applied_unverified when the rollback itself cannot be confirmed', async () => {
    harness = await makeHarness();
    const adapter = new RollbackResistantAdapter();
    harness.registry.register(adapter);

    const result = await harness.engine.execute(
      proposal(),
      environment({
        beforeSummary: summary({ 'cpu.temperature': 60 }),
        measureAfter: async () => summary({ 'cpu.temperature': 90 }),
      }),
      harness.actuatorContext,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied_unverified');
    expect(result.value.rolledBack).toBe(false);
    expect(result.value.summary).toContain('cannot confirm');
    expect((await harness.journal.list())[0]?.status).toBe('failed');
  });
});

describe('execute — audit trail', () => {
  it('records the whole operation in the audit log', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    await harness.engine.execute(proposal(), environment(), harness.actuatorContext);

    const events = await harness.eventLog.readAll();
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const kinds = events.value.map((e) => e.kind);
    expect(kinds).toContain('optimization.requested');
    expect(kinds).toContain('optimization.validated');
    expect(kinds).toContain('checkpoint.created');
    expect(kinds).toContain('optimization.applied');
    expect(kinds).toContain('optimization.measured');
    expect(kinds).toContain('optimization.kept');

    const verified = await harness.eventLog.verify();
    expect(verified.ok && verified.value.valid).toBe(true);

    // All events for one operation share a correlation id.
    const correlated = new Set(events.value.map((e) => e.correlationId).filter(Boolean));
    expect(correlated.size).toBe(1);
  });

  it('records the refusal when the kernel rejects', async () => {
    harness = await makeHarness();
    registerPowerAdapters(harness.registry);
    await harness.engine.execute(
      proposal({ changes: [change('power.processor.max_state', 10)] }),
      environment(),
      harness.actuatorContext,
    );
    const events = await harness.eventLog.readAll();
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => e.kind)).toContain('optimization.rejected');
  });
});

describe('noAction', () => {
  it('produces a first-class no-action outcome', async () => {
    harness = await makeHarness();
    const outcome = harness.engine.noAction(
      'negligible_benefit',
      'The expected gain does not justify the change.',
      classification(),
    );
    expect(outcome.status).toBe('no_action');
    expect(outcome.noActionReason).toBe('negligible_benefit');
    expect(outcome.appliedChanges).toHaveLength(0);
  });
});

/**
 * Applies the value and then reports failure — the powercfg case where the
 * setting is persisted but re-activating the scheme fails. The machine has
 * changed; the caller was told the write did not succeed.
 */
class LandsThenFailsAdapter extends MockControlAdapter {
  private observed = 5;

  constructor() {
    super('power.processor.min_state', { initial: 5 });
  }

  override async read(): ReturnType<MockControlAdapter['read']> {
    return { ok: true, value: this.observed };
  }

  override async write(
    _context: Parameters<MockControlAdapter['write']>[0],
    value: Parameters<MockControlAdapter['write']>[1],
  ): ReturnType<MockControlAdapter['write']> {
    if (typeof value === 'number') this.observed = value;
    // Restoring the captured value must succeed, or the test would be checking
    // the rollback-failure path instead.
    if (value === 5) return { ok: true, value: true };
    return { ok: false, error: nexusError('E_IO', 'scheme activation failed after the value was written') };
  }

  override get current(): number {
    return this.observed;
  }
}

/**
 * Applies the first write and verifies it, then silently ignores every later
 * write. That models a control NEXUS can change but cannot change back — the
 * case where the rollback itself is the thing that fails.
 */
class RollbackResistantAdapter extends MockControlAdapter {
  private writeCount = 0;
  private observed: number;

  constructor(initial = 5) {
    super('power.processor.min_state', { initial });
    this.observed = initial;
  }

  override async read(): ReturnType<MockControlAdapter['read']> {
    return { ok: true, value: this.observed };
  }

  override async write(
    _context: Parameters<MockControlAdapter['write']>[0],
    value: Parameters<MockControlAdapter['write']>[1],
  ): ReturnType<MockControlAdapter['write']> {
    this.writeCount += 1;
    if (this.writeCount === 1 && typeof value === 'number') this.observed = value;
    return { ok: true, value: true };
  }
}
