import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ExperimentStore } from '../../src/optimizer/experiment-store.js';
import { fingerprintExperiment } from '../../src/optimizer/experiment-plan.js';
import { resolvePaths } from '../../src/core/paths.js';
import { FixedClock } from '../../src/core/clock.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';

describe('ExperimentStore', () => {
  it('saves and finds a result by its fingerprint', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-exp-'));
    try {
      const clock = new FixedClock(1000);
      const store = new ExperimentStore(resolvePaths(home), clock, createLogger(new MemorySink(), 'error'));
      const fingerprint = fingerprintExperiment({
        machine: { cpu: '9950X3D', gpu: '7900 XT', memoryBytes: 96 * 1024 ** 3 },
        os: { version: 'Windows 11', build: '1' },
        platform: { driverVersion: '2', biosVersion: '3', chipsetVersion: '4' },
        workload: { applicationId: 'squad', gameBuild: 'A' },
      });
      const saved = await store.save({
        id: 'exp-1',
        fingerprint,
        applicationId: 'squad',
        candidate: { 'power.processor.epp': 32 },
        decision: 'keep',
        scorePercent: 3,
        confidenceLowPercent: 1.5,
        confidenceHighPercent: 4,
        createdAtMs: clock.now(),
        detail: 'measured',
      });
      expect(saved.ok).toBe(true);

      const found = await store.find(fingerprint);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value?.candidate['power.processor.epp']).toBe(32);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
