import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reconcileGameProfile, selectGameProfile, stageRestartChanges, type GameProfile } from '../../src/gaming/warden.js';

const profile: GameProfile = {
  id: 'example',
  name: 'Example Game',
  executableNames: ['ExampleGame.exe'],
  workloads: ['gaming'],
  version: 1,
  settings: [
    { key: 'amd.antiLag', value: true, rationale: 'reduce input latency when measured useful', applyTiming: 'relaunch' },
    { key: 'display.refreshHz', value: 165, rationale: 'keep the preferred panel target', applyTiming: 'reboot' },
  ],
};

test('reconciles desired and observed state without treating missing values as equal', () => {
  const result = reconcileGameProfile(profile, {
    executableName: 'ExampleGame.exe',
    settings: { 'amd.antiLag': true },
    driverVersion: 'x',
    gameVersion: 'y',
    observedAtMs: 1,
    source: 'live',
  });
  assert.equal(result.state, 'pending-reboot');
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0]?.key, 'display.refreshHz');
  assert.equal(stageRestartChanges(result).length, 1);
});

test('selects executable and workload-specific profile', () => {
  assert.equal(selectGameProfile([profile], 'examplegame.exe', 'gaming')?.id, 'example');
});
