import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointStagedChange, dueStagedChanges, expireStagedChanges, rollbackStagedChange, type StagedChange } from '../../src/gaming/staged-state.js';

const items: StagedChange[] = [
  { id: 'a', gameId: 'g', changes: [], timing: 'next-login', reason: 'boot drift', createdAtMs: 1, expiresAtMs: null },
  { id: 'b', gameId: 'g', changes: [], timing: 'next-launch', reason: 'game drift', createdAtMs: 1, expiresAtMs: null },
  { id: 'c', gameId: 'g', changes: [], timing: 'manual', reason: 'explicit', createdAtMs: 1, expiresAtMs: null },
];

test('staged changes activate only in their declared context', () => {
  assert.deepEqual(dueStagedChanges(items, 10, 'login').map((x) => x.id), ['a']);
  assert.deepEqual(dueStagedChanges(items, 10, 'launch').map((x) => x.id), ['b']);
  assert.deepEqual(dueStagedChanges(items, 10, 'manual').map((x) => ['a', 'b', 'c'].includes(x.id)), [true, true, true]);
});

test('expired changes are not returned', () => {
  const expiring = { ...items[0], expiresAtMs: 5 };
  assert.equal(expireStagedChanges([expiring], 5).length, 0);
});

test('staged changes carry the exact pre-change state needed for rollback', () => {
  const staged: StagedChange = { id: 's', gameId: 'g', changes: [{ key: 'amd.antiLag', value: true }], timing: 'next-launch', reason: 'repair drift', createdAtMs: 1, expiresAtMs: null };
  const checkpoint = checkpointStagedChange(staged, { 'amd.antiLag': false }, 'cp-1', 2);
  assert.equal(checkpoint.reversible, true);
  assert.deepEqual(rollbackStagedChange(checkpoint), { 'amd.antiLag': false });
});