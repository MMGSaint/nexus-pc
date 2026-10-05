import { describe, expect, it } from 'vitest';

import { WorkloadClassifier, signalsFromSnapshot } from '../../src/workload/classifier.js';
import type { WorkloadSignals } from '../../src/domain/workload.js';
import { MIN_ACTIONABLE_CONFIDENCE, isActionable, hintIsFresh } from '../../src/domain/workload.js';
import { telemetrySnapshot, T0 } from '../helpers/factories.js';

const classifier = new WorkloadClassifier();

function signals(overrides: Partial<WorkloadSignals> = {}): WorkloadSignals {
  return {
    timestampMs: T0,
    cpuUtilization: 10,
    gpuUtilization: 5,
    vramUsedBytes: 2 * 1024 ** 3,
    vramTotalBytes: 20 * 1024 ** 3,
    memoryUsedRatio: 0.2,
    processes: [],
    fidelity: 'live',
    ...overrides,
  };
}

describe('classification', () => {
  it('recognises an idle machine', () => {
    const result = classifier.classify(signals({ cpuUtilization: 2, gpuUtilization: 1 }));
    expect(result.workload).toBe('idle');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('recognises a GPU-bound workload', () => {
    const result = classifier.classify(signals({ cpuUtilization: 30, gpuUtilization: 96 }));
    expect(['gpu_bound', 'gaming']).toContain(result.workload);
  });

  it('recognises a CPU-bound workload', () => {
    const result = classifier.classify(signals({ cpuUtilization: 95, gpuUtilization: 5 }));
    expect(result.workload).toBe('cpu_bound');
  });

  it('uses a process name as a heuristic and says so', () => {
    const result = classifier.classify(
      signals({
        cpuUtilization: 40,
        gpuUtilization: 90,
        processes: [{ name: 'SquadGame.exe', pid: 1, cpuPercent: 30, workingSetBytes: null, isForeground: true }],
      }),
    );
    expect(result.workload).toBe('gaming');
    const reasons = result.candidates.find((c) => c.workload === 'gaming')?.reasons.join(' ') ?? '';
    expect(reasons).toContain('heuristic');
  });

  it('recognises streaming when an encoder runs alongside a game', () => {
    const result = classifier.classify(
      signals({
        cpuUtilization: 60,
        gpuUtilization: 85,
        processes: [
          { name: 'obs64.exe', pid: 1, cpuPercent: 20, workingSetBytes: null, isForeground: false },
          { name: 'SquadGame.exe', pid: 2, cpuPercent: 40, workingSetBytes: null, isForeground: true },
        ],
      }),
    );
    expect(result.workload).toBe('streaming');
  });

  it('prefers a foreground game over a background-only name match', () => {
    const background = classifier.classify(
      signals({
        cpuUtilization: 40,
        gpuUtilization: 90,
        processes: [
          { name: 'SquadGame.exe', pid: 1, cpuPercent: 30, workingSetBytes: null, isForeground: false },
          { name: 'chrome.exe', pid: 2, cpuPercent: 5, workingSetBytes: null, isForeground: true },
        ],
      }),
    );
    const foreground = classifier.classify(
      signals({
        cpuUtilization: 40,
        gpuUtilization: 90,
        processes: [
          { name: 'SquadGame.exe', pid: 1, cpuPercent: 30, workingSetBytes: null, isForeground: true },
          { name: 'chrome.exe', pid: 2, cpuPercent: 5, workingSetBytes: null, isForeground: false },
        ],
      }),
    );
    const bgReasons = background.candidates.find((c) => c.workload === 'gaming')?.reasons.join(' ') ?? '';
    const fgReasons = foreground.candidates.find((c) => c.workload === 'gaming')?.reasons.join(' ') ?? '';
    expect(bgReasons).toContain('background');
    expect(fgReasons).toContain('foreground');
    expect(foreground.candidates.find((c) => c.workload === 'gaming')!.score).toBeGreaterThan(
      background.candidates.find((c) => c.workload === 'gaming')!.score,
    );
  });

  it('does not treat null isForeground as background', () => {
    const result = classifier.classify(
      signals({
        cpuUtilization: 40,
        gpuUtilization: 90,
        processes: [{ name: 'SquadGame.exe', pid: 1, cpuPercent: 30, workingSetBytes: null, isForeground: null }],
      }),
    );
    const reasons = result.candidates.find((c) => c.workload === 'gaming')?.reasons.join(' ') ?? '';
    expect(reasons).not.toContain('background');
    expect(reasons).not.toContain('foreground');
  });
});

describe('uncertainty', () => {
  it('reports unknown rather than guessing when nothing is measurable', () => {
    const result = classifier.classify(
      signals({ cpuUtilization: null, gpuUtilization: null, vramUsedBytes: null, vramTotalBytes: null }),
    );
    expect(result.workload).toBe('unknown');
    expect(result.confidence).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
    expect(isActionable(result)).toBe(false);
  });

  it('lists the signals it was missing', () => {
    const result = classifier.classify(signals({ gpuUtilization: null }));
    expect(result.missingSignals).toContain('gpu.utilization');
    expect(result.explanation).toContain('Confidence is capped');
  });

  it('caps confidence when the signals are not live', () => {
    const live = classifier.classify(signals({ cpuUtilization: 2, gpuUtilization: 1 }));
    const mocked = classifier.classify(signals({ cpuUtilization: 2, gpuUtilization: 1, fidelity: 'mocked' }));
    expect(mocked.confidence).toBeLessThan(live.confidence);
    expect(mocked.confidence).toBeLessThanOrEqual(0.5);
  });

  it('never reports confidence above 1 or below 0', () => {
    for (const cpu of [0, 50, 100, 180]) {
      const result = classifier.classify(signals({ cpuUtilization: cpu }));
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('lowers confidence when two candidates are close', () => {
    const result = classifier.classify(signals({ cpuUtilization: 60, gpuUtilization: 60 }));
    expect(result.confidence).toBeLessThan(0.7);
  });
});

describe('Vesper context hints', () => {
  const hint = {
    workload: 'streaming' as const,
    declaredBy: 'vesper',
    declaredAtMs: T0,
    ttlMs: 600_000,
  };

  it('raises confidence when the hint agrees with observation', () => {
    const observed = signals({
      cpuUtilization: 60,
      gpuUtilization: 85,
      processes: [{ name: 'obs64.exe', pid: 1, cpuPercent: 20, workingSetBytes: null, isForeground: false }],
    });
    const without = classifier.classify(observed);
    const withHint = classifier.classify(observed, hint);
    expect(withHint.workload).toBe('streaming');
    expect(withHint.confidence).toBeGreaterThan(without.confidence);
    expect(withHint.contextConflict).toBe(false);
  });

  it('never raises confidence to certainty on a hint alone', () => {
    const withHint = classifier.classify(signals({ cpuUtilization: 2, gpuUtilization: 1 }), {
      ...hint,
      workload: 'idle',
    });
    expect(withHint.confidence).toBeLessThanOrEqual(0.95);
  });

  it('reports a conflict rather than deferring to the hint', () => {
    const result = classifier.classify(signals({ cpuUtilization: 2, gpuUtilization: 1 }), hint);
    expect(result.contextConflict).toBe(true);
    expect(result.workload).toBe('idle');
    expect(result.explanation).toContain('not visible in the telemetry');
    expect(result.declaredContext?.declaredBy).toBe('vesper');
  });

  it('cannot lift confidence past the cap that missing signals imposed', () => {
    // Three signals missing caps confidence well below the action floor. An
    // agreeing hint corroborates; it does not supply the missing evidence, so
    // it must not push the classification back over the floor.
    const starved = signals({
      cpuUtilization: null,
      gpuUtilization: null,
      vramUsedBytes: null,
      vramTotalBytes: null,
    });
    const result = classifier.classify(starved, { ...hint, workload: 'unknown' });
    expect(result.confidence).toBeLessThan(MIN_ACTIONABLE_CONFIDENCE);
    expect(isActionable(result)).toBe(false);
  });

  it('cannot lift confidence past the cap that non-live signals imposed', () => {
    const mocked = signals({
      cpuUtilization: 30,
      gpuUtilization: 96,
      fidelity: 'mocked',
      processes: [{ name: 'obs64.exe', pid: 1, cpuPercent: 20, workingSetBytes: null, isForeground: false }],
    });
    const withHint = classifier.classify(mocked, hint);
    // Agreement raises nothing above the 0.5 ceiling that mocked signals carry,
    // so a simulation plus a hint still cannot authorise a change.
    expect(withHint.confidence).toBeLessThanOrEqual(0.5);
    expect(isActionable(withHint)).toBe(false);
  });

  it('ignores an expired hint', () => {
    const stale = { ...hint, declaredAtMs: T0 - 3_600_000, ttlMs: 60_000 };
    expect(hintIsFresh(stale, T0)).toBe(false);
    const result = classifier.classify(signals({ cpuUtilization: 2, gpuUtilization: 1 }), stale);
    expect(result.declaredContext).toBeUndefined();
    expect(result.contextConflict).toBe(false);
  });

  it('does not let a hint make an unknown workload actionable on its own', () => {
    const result = classifier.classify(
      signals({ cpuUtilization: null, gpuUtilization: null, vramUsedBytes: null, vramTotalBytes: null }),
      hint,
    );
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('signalsFromSnapshot', () => {
  it('treats an unknown reading as null rather than zero', () => {
    const snapshot = telemetrySnapshot();
    const derived = signalsFromSnapshot(snapshot);
    expect(derived.gpuUtilization).toBeNull();
    expect(derived.cpuUtilization).toBe(20);
    expect(derived.fidelity).toBe('live');
  });
});
