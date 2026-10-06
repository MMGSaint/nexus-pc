import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileDriver } from '../../src/gaming/driver-state.js';

test('detects driver drift', () => {
  const result = reconcileDriver(
    {
      driverVersion: '24.1.1',
      capturedAtMs: 1,
      gameProfilesHash: 'a',
      amdStateHash: 'b',
      displayStateHash: 'c',
      vrStateHash: 'd',
      nexusProfileId: 'gaming',
    },
    {
      driverVersion: '24.2.1',
      observedAtMs: 2,
      source: 'live',
    },
  );
  assert.equal(result.state, 'changed');
  assert.equal(result.recoverable, true);
});

test('unknown driver identity never triggers restoration', () => {
  const result = reconcileDriver(null, { driverVersion: null, observedAtMs: 1, source: 'unavailable' });
  assert.equal(result.state, 'unknown');
});
