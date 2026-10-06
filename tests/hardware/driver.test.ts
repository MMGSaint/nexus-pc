import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptedCommandRunner, commandOk } from '../../src/core/exec.js';
import { readWindowsDisplayDriver } from '../../src/hardware/driver.js';

test('display driver identity parses signed-driver output', async () => {
  const runner = new ScriptedCommandRunner([{ match: (request) => request.file.toLowerCase() === 'powershell.exe', result: commandOk('{"version":"32.0.1.2","provider":"Advanced Micro Devices, Inc.","deviceName":"AMD Radeon"}') }]);
  const result = await readWindowsDisplayDriver(runner, 123);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.version, '32.0.1.2');
  assert.equal(result.value.provider, 'Advanced Micro Devices, Inc.');
});

test('driver identity refuses malformed output', async () => {
  const runner = new ScriptedCommandRunner([{ match: (request) => request.file.toLowerCase() === 'powershell.exe', result: commandOk('{"provider":"AMD"}') }]);
  const result = await readWindowsDisplayDriver(runner, 123);
  assert.equal(result.ok, false);
});