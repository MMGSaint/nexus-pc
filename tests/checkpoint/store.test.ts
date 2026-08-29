import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FixedClock } from '../../src/core/clock.js';
import { SequentialIds } from '../../src/core/ids.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { ScriptedCommandRunner } from '../../src/core/exec.js';
import { CheckpointStore } from '../../src/checkpoint/store.js';
import { ActuatorRegistry, MockControlAdapter } from '../../src/optimizer/actuator.js';
import type { ActuatorContext } from '../../src/optimizer/actuator.js';

const logger = createLogger(new MemorySink(), 'debug');

function actuatorContext(): ActuatorContext {
  return { clock: new FixedClock(), logger, runner: new ScriptedCommandRunner(), timeoutMs: 1000 };
}

async function withStore(
  fn: (store: CheckpointStore, registry: ActuatorRegistry, context: ActuatorContext) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-ckpt-'));
  try {
    const registry = new ActuatorRegistry();
    const store = new CheckpointStore({
      paths: resolvePaths(home),
      clock: new FixedClock(),
      logger,
      ids: new SequentialIds(),
      sessionId: 'sess_test',
      registry,
    });
    await fn(store, registry, actuatorContext());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('CheckpointStore capture', () => {
  it('records the prior value of each control', async () => {
    await withStore(async (store, registry, context) => {
      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 5 }));
      registry.register(new MockControlAdapter('power.processor.max_state', { initial: 100 }));

      const result = await store.capture(
        ['power.processor.min_state', 'power.processor.max_state'],
        'before a test change',
        context,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.partial).toBe(false);
      expect(result.value.entries.map((e) => e.previousValue)).toEqual([5, 100]);
    });
  });

  it('marks a control unrestorable when its value cannot be read', async () => {
    await withStore(async (store, registry, context) => {
      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 5, readFails: true }));
      const result = await store.capture(['power.processor.min_state'], 'test', context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.partial).toBe(true);
      expect(result.value.entries[0]?.restorable).toBe(false);
      expect(result.value.entries[0]?.reason).toContain('could not read');
    });
  });

  it('records a control with no adapter rather than dropping it', async () => {
    await withStore(async (store, _registry, context) => {
      const result = await store.capture(['power.processor.min_state'], 'test', context);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries[0]?.restorable).toBe(false);
      expect(result.value.entries[0]?.adapterId).toBe('none');
    });
  });

  it('refuses an empty checkpoint', async () => {
    await withStore(async (store, _registry, context) => {
      const result = await store.capture([], 'test', context);
      expect(result.ok).toBe(false);
    });
  });

  it('survives a reload from disk', async () => {
    await withStore(async (store, registry, context) => {
      registry.register(new MockControlAdapter('power.scheme.active', { initial: 'guid-original' }));
      const created = await store.capture(['power.scheme.active'], 'test', context);
      if (!created.ok) throw created.error;

      const loaded = await store.load(created.value.id);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.entries[0]?.previousValue).toBe('guid-original');
    });
  });

  it('rejects a malformed checkpoint id instead of touching the filesystem', async () => {
    await withStore(async (store) => {
      const result = await store.load('../../etc/passwd');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_INVALID_INPUT');
    });
  });
});

describe('CheckpointStore restore', () => {
  it('puts the captured values back', async () => {
    await withStore(async (store, registry, context) => {
      const adapter = new MockControlAdapter('power.processor.min_state', { initial: 5 });
      registry.register(adapter);

      const created = await store.capture(['power.processor.min_state'], 'test', context);
      if (!created.ok) throw created.error;
      await adapter.write(context, 40);
      expect(adapter.current).toBe(40);

      const restored = await store.restore(created.value.id, context);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.value.complete).toBe(true);
      expect(adapter.current).toBe(5);
    });
  });

  it('refuses to restore a control outside the checkpoint', async () => {
    await withStore(async (store, registry, context) => {
      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 5 }));
      registry.register(new MockControlAdapter('power.processor.max_state', { initial: 100 }));

      const created = await store.capture(['power.processor.min_state'], 'test', context);
      if (!created.ok) throw created.error;

      const restored = await store.restore(created.value.id, context, ['power.processor.max_state']);
      expect(restored.ok).toBe(false);
      if (restored.ok) return;
      expect(restored.error.message).toContain('rollback scope error');
    });
  });

  it('allows narrowing the restore to a subset of the checkpoint', async () => {
    await withStore(async (store, registry, context) => {
      const min = new MockControlAdapter('power.processor.min_state', { initial: 5 });
      const max = new MockControlAdapter('power.processor.max_state', { initial: 100 });
      registry.register(min);
      registry.register(max);

      const created = await store.capture(
        ['power.processor.min_state', 'power.processor.max_state'],
        'test',
        context,
      );
      if (!created.ok) throw created.error;
      await min.write(context, 40);
      await max.write(context, 70);

      const restored = await store.restore(created.value.id, context, ['power.processor.min_state']);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(min.current).toBe(5);
      expect(max.current).toBe(70); // untouched
      expect(restored.value.entries).toHaveLength(1);
    });
  });

  it('reports incomplete rather than claiming success when a restore fails', async () => {
    await withStore(async (store, registry, context) => {
      const adapter = new MockControlAdapter('power.processor.min_state', { initial: 5 });
      registry.register(adapter);
      const created = await store.capture(['power.processor.min_state'], 'test', context);
      if (!created.ok) throw created.error;

      // Swap in an adapter whose writes are silently ignored.
      registry.register(
        new MockControlAdapter('power.processor.min_state', { initial: 40, writeSilentlyIgnored: true }),
      );

      const restored = await store.restore(created.value.id, context);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.value.complete).toBe(false);
      expect(restored.value.entries[0]?.verified).toBe(false);
      expect(restored.value.entries[0]?.message).toContain('reading it back returned');
    });
  });

  it('does not claim to restore a control it could not capture', async () => {
    await withStore(async (store, registry, context) => {
      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 5, readFails: true }));
      const created = await store.capture(['power.processor.min_state'], 'test', context);
      if (!created.ok) throw created.error;

      const restored = await store.restore(created.value.id, context);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.value.complete).toBe(false);
      expect(restored.value.entries[0]?.restored).toBe(false);
    });
  });

  it('reports failure when the write itself fails', async () => {
    await withStore(async (store, registry, context) => {
      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 5 }));
      const created = await store.capture(['power.processor.min_state'], 'test', context);
      if (!created.ok) throw created.error;

      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 9, writeFails: true }));
      const restored = await store.restore(created.value.id, context);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.value.entries[0]?.message).toContain('restore failed');
    });
  });
});

describe('CheckpointStore retention', () => {
  it('keeps the number of checkpoints bounded', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-ckpt-'));
    try {
      const registry = new ActuatorRegistry();
      registry.register(new MockControlAdapter('power.processor.min_state', { initial: 5 }));
      const clock = new FixedClock();
      const store = new CheckpointStore({
        paths: resolvePaths(home),
        clock,
        logger,
        ids: new SequentialIds(),
        sessionId: 's',
        registry,
        maxCheckpoints: 3,
      });
      const context = actuatorContext();
      for (let i = 0; i < 8; i += 1) {
        clock.advance(1000);
        await store.capture(['power.processor.min_state'], `capture ${i}`, context);
      }
      const ids = await store.list();
      expect(ids.length).toBe(3);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
