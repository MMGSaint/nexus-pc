import { describe, expect, it } from 'vitest';

import {
  bootstrapInterval,
  statisticallyCredibleImprovement,
  summarizeFrames,
} from '../../src/performance/stats.js';

describe('frame performance statistics', () => {
  it('summarizes average FPS and low-percentile frame performance', () => {
    const summary = summarizeFrames([
      { frameTimeMs: 10 },
      { frameTimeMs: 10 },
      { frameTimeMs: 20 },
      { frameTimeMs: 10 },
      { frameTimeMs: 30 },
    ]);

    expect(summary.sampleCount).toBe(5);
    expect(summary.averageFrameTimeMs).toBe(16);
    expect(summary.fps).toBeCloseTo(62.5, 5);
    expect(summary.fps1PercentLow).toBeCloseTo(33.3333333333, 5);
    expect(summary.frameTimeStdDevMs).toBeGreaterThan(0);
  });

  it('computes deterministic bootstrap intervals', () => {
    const a = bootstrapInterval([1, 2, 3, 4, 5], (sample) =>
      sample.reduce((sum, value) => sum + value, 0) / sample.length,
      { resamples: 500, seed: 42 },
    );
    const b = bootstrapInterval([1, 2, 3, 4, 5], (sample) =>
      sample.reduce((sum, value) => sum + value, 0) / sample.length,
      { resamples: 500, seed: 42 },
    );

    expect(a).toEqual(b);
    expect(a.estimate).toBe(3);
    expect(a.low).toBeLessThanOrEqual(3);
    expect(a.high).toBeGreaterThanOrEqual(3);
  });

  it('only keeps an effect when the CI clears the practical threshold', () => {
    const credible = statisticallyCredibleImprovement([3, 4, 5, 4, 3], {
      practicalThresholdPercent: 1,
      seed: 7,
    });
    const noisy = statisticallyCredibleImprovement([0.4, -0.2, 0.8, -0.1, 0.3], {
      practicalThresholdPercent: 1,
      seed: 7,
    });

    expect(credible.keep).toBe(true);
    expect(noisy.keep).toBe(false);
  });
});
