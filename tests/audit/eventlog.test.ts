import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FixedClock } from '../../src/core/clock.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { registerSecret, clearRegisteredSecrets } from '../../src/core/redact.js';
import { EventLog, segmentName } from '../../src/audit/eventlog.js';
import { GENESIS_HASH } from '../../src/domain/events.js';

const logger = createLogger(new MemorySink(), 'debug');

async function withLog(
  fn: (log: EventLog, home: string, clock: FixedClock) => Promise<void>,
  options: Partial<ConstructorParameters<typeof EventLog>[0]> = {},
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-audit-'));
  const clock = new FixedClock();
  try {
    const log = new EventLog({
      paths: resolvePaths(home),
      clock,
      logger,
      sessionId: 'sess_test',
      ...options,
    });
    const opened = await log.open();
    expect(opened.ok).toBe(true);
    await fn(log, home, clock);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('EventLog', () => {
  it('starts a fresh chain from the genesis hash', async () => {
    await withLog(async (log) => {
      const first = await log.append({ kind: 'session.start', severity: 'info', message: 'hello' });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.seq).toBe(1);
      expect(first.value.prevHash).toBe(GENESIS_HASH);
    });
  });

  it('links each record to the one before it', async () => {
    await withLog(async (log) => {
      const a = await log.append({ kind: 'session.start', severity: 'info', message: 'a' });
      const b = await log.append({ kind: 'hardware.discovered', severity: 'info', message: 'b' });
      if (!a.ok || !b.ok) throw new Error('append failed');
      expect(b.value.prevHash).toBe(a.value.hash);
      expect(b.value.seq).toBe(2);
    });
  });

  it('verifies an intact chain', async () => {
    await withLog(async (log) => {
      for (let i = 0; i < 5; i += 1) {
        await log.append({ kind: 'capability.probed', severity: 'info', message: `probe ${i}` });
      }
      const verified = await log.verify();
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.valid).toBe(true);
      expect(verified.value.recordsChecked).toBe(5);
    });
  });

  it('detects an edited record', async () => {
    await withLog(async (log, home) => {
      await log.append({ kind: 'optimization.applied', severity: 'notice', message: 'original' });
      await log.append({ kind: 'optimization.kept', severity: 'notice', message: 'second' });

      const file = path.join(resolvePaths(home).events, segmentName(1));
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('original', 'tampered'));

      const verified = await log.verify();
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.valid).toBe(false);
      expect(verified.value.firstBrokenSeq).toBe(1);
      expect(verified.value.reason).toContain('hash does not match');
    });
  });

  it('detects a deleted record', async () => {
    await withLog(async (log, home) => {
      for (let i = 0; i < 4; i += 1) {
        await log.append({ kind: 'capability.probed', severity: 'info', message: `p${i}` });
      }
      const file = path.join(resolvePaths(home).events, segmentName(1));
      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      lines.splice(1, 1);
      await writeFile(file, `${lines.join('\n')}\n`);

      const verified = await log.verify();
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.valid).toBe(false);
      expect(verified.value.reason).toContain('sequence jumped');
    });
  });

  it('resumes the chain across a reopen', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-audit-'));
    try {
      const paths = resolvePaths(home);
      const clock = new FixedClock();
      const first = new EventLog({ paths, clock, logger, sessionId: 's1' });
      await first.open();
      const a = await first.append({ kind: 'session.start', severity: 'info', message: 'one' });
      if (!a.ok) throw new Error('append failed');

      const second = new EventLog({ paths, clock, logger, sessionId: 's2' });
      await second.open();
      expect(second.sequence).toBe(2);
      const b = await second.append({ kind: 'session.end', severity: 'info', message: 'two' });
      if (!b.ok) throw new Error('append failed');
      expect(b.value.prevHash).toBe(a.value.hash);

      const verified = await second.verify();
      expect(verified.ok && verified.value.valid).toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps the chain intact across a segment rotation', async () => {
    await withLog(
      async (log) => {
        for (let i = 0; i < 40; i += 1) {
          await log.append({
            kind: 'capability.probed',
            severity: 'info',
            message: `padding padding padding padding ${i}`,
          });
        }
        const verified = await log.verify();
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(verified.value.valid).toBe(true);
        expect(verified.value.recordsChecked).toBe(40);
      },
      { maxSegmentBytes: 512 },
    );
  });

  it('redacts credential-shaped fields', async () => {
    await withLog(async (log) => {
      const appended = await log.append({
        kind: 'vesper.connected',
        severity: 'info',
        message: 'client connected',
        data: { clientId: 'vesper', authToken: 'super-secret-value', nested: { apiKey: 'abc123def456' } },
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      const serialized = JSON.stringify(appended.value.data);
      expect(serialized).not.toContain('super-secret-value');
      expect(serialized).not.toContain('abc123def456');
      expect(serialized).toContain('[redacted]');
      expect(serialized).toContain('vesper');
    });
  });

  it('scrubs a registered secret even from an unlabelled field', async () => {
    clearRegisteredSecrets();
    registerSecret('literal-secret-material');
    try {
      await withLog(async (log) => {
        const appended = await log.append({
          kind: 'vesper.rejected',
          severity: 'warning',
          message: 'rejected client presenting literal-secret-material',
          data: { detail: 'saw literal-secret-material in the header' },
        });
        if (!appended.ok) throw new Error('append failed');
        expect(appended.value.message).not.toContain('literal-secret-material');
        expect(JSON.stringify(appended.value.data)).not.toContain('literal-secret-material');
      });
    } finally {
      clearRegisteredSecrets();
    }
  });

  it('serialises concurrent appends without breaking the chain', async () => {
    await withLog(async (log) => {
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          log.append({ kind: 'capability.probed', severity: 'info', message: `concurrent ${i}` }),
        ),
      );
      const verified = await log.verify();
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.valid).toBe(true);
      expect(verified.value.recordsChecked).toBe(25);
    });
  });

  it('prunes old segments but never below the minimum', async () => {
    await withLog(
      async (log) => {
        for (let i = 0; i < 200; i += 1) {
          await log.append({
            kind: 'capability.probed',
            severity: 'info',
            message: `padding padding padding padding padding ${i}`,
          });
        }
        await log.prune();
        const all = await log.readAll();
        expect(all.ok).toBe(true);
        if (!all.ok) return;
        // Pruning removed history, but the log is not empty.
        expect(all.value.length).toBeGreaterThan(0);
        expect(all.value.length).toBeLessThan(200);
      },
      { maxSegmentBytes: 256, maxSegments: 3, minSegments: 2 },
    );
  });

  it('refuses to append before the log is open', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-audit-'));
    try {
      const log = new EventLog({
        paths: resolvePaths(home),
        clock: new FixedClock(),
        logger,
        sessionId: 's',
      });
      const result = await log.append({ kind: 'session.start', severity: 'info', message: 'x' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_STATE');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
