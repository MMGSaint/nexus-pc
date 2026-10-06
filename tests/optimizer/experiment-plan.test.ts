import { describe, expect, it } from 'vitest';

import {
  decideExperiment,
  fingerprintExperiment,
  interleaveBaseline,
  makeCandidateGrid,
} from '../../src/optimizer/experiment-plan.js';

describe('optimization experiment planner', () => {
  it('creates a bounded deterministic Cartesian candidate grid', () => {
    const candidates = makeCandidateGrid([
      { control: 'power.processor.epp', candidates: [0, 50, 100] },
      { control: 'power.processor.boost_mode', candidates: [2, 3] },
    ]);
    expect(candidates).toHaveLength(6);
    expect(candidates[0]?.id).not.toBe(candidates[1]?.id);
    expect(candidates[0]?.values).toEqual({
      'power.processor.boost_mode': 2,
      'power.processor.epp': 0,
    });
  });

  it('bounds Cartesian explosion', () => {
    expect(makeCandidateGrid([
      { control: 'a', candidates: [1, 2, 3] },
      { control: 'b', candidates: [1, 2, 3] },
      { control: 'c', candidates: [1, 2, 3] },
    ], 5)).toHaveLength(5);
  });

  it('interleaves baseline around a candidate', () => {
    const schedule = interleaveBaseline(
      { id: 'candidate-x', values: { x: 2 } },
      2,
    );
    expect(schedule).toEqual(['baseline', 'candidate-x', 'baseline', 'candidate-x', 'baseline']);
  });

  it('fingerprint changes when the game build changes', () => {
    const base = {
      machine: { cpu: '9950X3D', gpu: 'RX 7900 XT', memoryBytes: 96 * 1024 ** 3 },
      os: { version: 'Windows 11', build: '26100' },
      platform: { driverVersion: '1', biosVersion: '2', chipsetVersion: '3' },
      workload: { applicationId: 'squad', gameBuild: 'A' },
    } as const;
    const a = fingerprintExperiment(base);
    const b = fingerprintExperiment({ ...base, workload: { ...base.workload, gameBuild: 'B' } });
    expect(a.value).not.toBe(b.value);
  });

  it('never keeps a statistically good result when stability regressed', () => {
    const decision = decideExperiment([3, 4, 5, 4, 3], {
      stabilityRegression: true,
      seed: 42,
    });
    expect(decision.keep).toBe(false);
    expect(decision.stabilityRegression).toBe(true);
  });
});
