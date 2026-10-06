import assert from 'node:assert/strict';
import test from 'node:test';
import { frameBenefit, reconcileGameProfile, selectGameProfile, stageRestartChanges, type GameProfile } from '../../src/gaming/warden.js';

const profile: GameProfile = { id: 'example', name: 'Example Game', executableNames: ['ExampleGame.exe'], workloads: ['gaming'], version: 1, settings: [
  { key: 'amd.antiLag', value: true, rationale: 'reduce input latency when measured useful', applyTiming: 'relaunch' },
  { key: 'display.refreshHz', value: 165, rationale: 'keep the preferred panel target', applyTiming: 'reboot' },
] };

test('reconciles desired and observed state without treating missing values as equal', () => {
  const result = reconcileGameProfile(profile, { executableName: 'ExampleGame.exe', settings: { 'amd.antiLag': true }, driverVersion: 'x', gameVersion: 'y', observedAtMs: 1, source: 'live' });
  assert.equal(result.state, 'pending-reboot');
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0]?.key, 'display.refreshHz');
  assert.equal(stageRestartChanges(result).length, 1);
});

test('selects executable and workload-specific profile', () => {
  assert.equal(selectGameProfile([profile], 'examplegame.exe', 'gaming')?.id, 'example');
});

test('WARDEN keeps VR profiles isolated from flat-screen selection', () => {
  const vr: GameProfile = { ...profile, id: 'vr', name: 'VR', vr: true };
  assert.equal(selectGameProfile([profile, vr], 'ExampleGame.exe', 'gaming', true)?.id, 'vr');
  assert.equal(selectGameProfile([profile, vr], 'ExampleGame.exe', 'gaming', false)?.id, 'example');
});

test('WARDEN exposes frame-truth benefit decisions', () => {
  const summary = { sampleCount: 300, durationMs: 3000, averageFrameTimeMs: 10, fps: 100, fps1PercentLow: 80, fps0_1PercentLow: 70, p95FrameTimeMs: 14, p99FrameTimeMs: 18, frameTimeStdDevMs: 1.5, droppedFrames: 0, droppedFramesKnown: true };
  const result = frameBenefit({ capturedAtMs: 1, fidelity: 'live', summary }, { capturedAtMs: 2, fidelity: 'live', summary: { ...summary, averageFrameTimeMs: 9, fps1PercentLow: 90 } });
  assert.equal(result.decision, 'benefit');
});