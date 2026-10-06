import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reconcileAmdGameState } from '../../src/gaming/amd.js';

test('AMD reconciliation distrusts non-live driver state', () => {
  const result = reconcileAmdGameState(
    { 'amd.3d.example': true },
    {
      driverVersion: null,
      settings: [],
      observedAtMs: 1,
      source: 'unavailable',
    },
  );
  assert.equal(result.trustworthy, false);
  assert.equal(result.drift.length, 1);
});

test('live observed settings produce deterministic drift', () => {
  const result = reconcileAmdGameState(
    { 'amd.3d.example': true },
    {
      driverVersion: 'driver',
      settings: [{ key: 'amd.3d.example', value: false, source: 'adlx' }],
      observedAtMs: 1,
      source: 'live',
    },
  );
  assert.equal(result.trustworthy, true);
  assert.equal(result.drift[0]?.desired, true);
});
