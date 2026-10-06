import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evaluateVr, vrSetting, type VrProfile } from '../../src/vr/profile.js';

const profile: VrProfile = {
  id: 'vr-safe',
  name: 'VR Safe',
  priorities: ['frame-pacing', 'latency', 'thermal-headroom'],
  targetRefreshHz: 90,
  settings: [vrSetting('capture.enabled', false, 'pause capture when it causes measurable compositor pressure')],
  maxGpuUtilizationPct: 92,
  minHeadroomPct: 8,
};

test('VR evaluates compositor budget before suggesting changes', () => {
  const result = evaluateVr(profile, {
    active: true,
    runtime: 'OpenXR',
    headset: 'Example HMD',
    refreshHz: 90,
    compositorFrameTimeMs: 12,
    appFrameTimeMs: 11,
    gpuUtilizationPct: 96,
    gpuTemperatureC: 75,
    source: 'live',
  });
  assert.equal(result.healthy, false);
  assert.ok(result.reasons.some((reason) => reason.includes('headroom')));
  assert.equal(result.proposed[0]?.key, 'capture.enabled');
});


test('VR policy refuses to act when required instrumentation is unavailable', () => {
  const gated: VrProfile = {
    ...profile,
    requiredCapabilities: ['openxr.runtime', 'frame.compositor'],
  };
  const result = evaluateVr(gated, {
    active: true,
    runtime: 'OpenXR',
    headset: 'Example HMD',
    refreshHz: 90,
    compositorFrameTimeMs: 10,
    appFrameTimeMs: 10,
    gpuUtilizationPct: 70,
    gpuTemperatureC: 70,
    source: 'live',
    capabilities: { 'openxr.runtime': true, 'frame.compositor': false },
  });
  assert.equal(result.supported, false);
  assert.deepEqual(result.proposed, []);
});
