import assert from 'node:assert/strict';
import test from 'node:test';
import { dueStagedChanges, expireStagedChanges, type StagedChange } from '../../src/gaming/staged-state.js';

const items: StagedChange[] = [
  { id: 'a', gameId: 'g', changes: [], timing: 'next-login', reason: 'boot drift', createdAtMs: 1, expiresAtMs: null },
  { id: 'b', gameId: 'g', changes: [], timing: 'next-launch', reason: 'game drift', createdAtMs: 1, expiresAtMs: null },
  { id: 'c', gameId: 'g', changes: [], timing: 'manual', reason: 'explicit', createdAtMs: 1, expiresAtMs: null },
];

test('staged changes activate only in their declared context', () => {
  assert.deepEqual(dueStagedChanges(items, 10, 'login').map((x) => x.id), ['a']);
  assert.deepEqual(dueStagedChanges(items, 10, 'launch').map((x) => x.id), ['b']);
  assert.deepEqual(dueStagedChanges(items, 10, 'manual').map((x) => ['a','b','c'].includes(x.id)), [true,true,true]);
});

test('expired changes are not returned', () => {
  const expiring: StagedChange = { ...items[0]!, expiresAtMs: 5 };
  assert.equal(expireStagedChanges([expiring], 5).length, 0);
});
