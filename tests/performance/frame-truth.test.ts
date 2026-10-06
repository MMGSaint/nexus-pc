import assert from 'node:assert/strict';
import test from 'node:test';
import { frameTruthReadings, requireFrameBenefit, type FrameTruth } from '../../src/performance/frame-truth.js';

const base = (overrides: Partial<FrameTruth['summary']> = {}): FrameTruth => ({
  capturedAtMs: 1,
  fidelity: 'live',
  summary: { sampleCount: 300, durationMs: 3000, averageFrameTimeMs: 10, fps: 100, fps1PercentLow: 80, fps0_1PercentLow: 70, p95FrameTimeMs: 14, p99FrameTimeMs: 18, frameTimeStdDevMs: 1.5, droppedFrames: 0, droppedFramesKnown: true, ...overrides },
});

test('frame truth recognizes a meaningful improvement', () => {
  const result = requireFrameBenefit(base(), base({ averageFrameTimeMs: 9, fps1PercentLow: 90, fps0_1PercentLow: 82, p95FrameTimeMs: 13, p99FrameTimeMs: 16, frameTimeStdDevMs: 1.2 }));
  assert.equal(result.decision, 'benefit');
});

test('frame truth detects dropped-frame regression even with mixed metrics', () => {
  const result = requireFrameBenefit(base(), base({ averageFrameTimeMs: 9, fps1PercentLow: 82, fps0_1PercentLow: 71, p95FrameTimeMs: 13, p99FrameTimeMs: 17, frameTimeStdDevMs: 1.4, droppedFrames: 2 }));
  assert.equal(result.decision, 'regression');
});

test('frame truth refuses to decide without live evidence or enough samples', () => {
  assert.equal(requireFrameBenefit(base({ sampleCount: 10 }), base()).decision, 'insufficient_evidence');
  assert.equal(requireFrameBenefit(base(), { ...base(), fidelity: 'mocked' }).decision, 'insufficient_evidence');
});

test('frame truth converts directly into typed telemetry readings', () => {
  const truth = base();
  const readings = frameTruthReadings(truth);
  assert.equal(readings.find((r) => r.metric === 'frame.fps')?.value, 100);
  assert.equal(readings.find((r) => r.metric === 'frame.time.stddev')?.unit, 'millisecond');
});
