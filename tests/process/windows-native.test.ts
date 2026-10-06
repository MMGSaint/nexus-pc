import { describe, expect, it } from 'vitest';

import { commandOk, ScriptedCommandRunner } from '../../src/core/exec.js';
import { getForegroundProcess, getSystemCpuSets, setProcessDefaultCpuSets } from '../../src/process/windows-native.js';
import { WindowsProcessPlacementController } from '../../src/process/placement.js';

const HELPER = 'C:\\NEXUS\\native-windows-helper.exe';

describe('native Windows bridge', () => {
  it('fails closed without an explicitly configured helper path on Windows', async () => {
    const runner = new ScriptedCommandRunner();
    const result = await getForegroundProcess(runner, { executable: HELPER });
    if (process.platform === 'win32') {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('E_UNAVAILABLE');
      expect(runner.requests).toHaveLength(0);
    }
  });
  it('parses a foreground response from the bounded helper', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: r => r.file === HELPER && r.args.length === 0,
        result: commandOk(JSON.stringify({
          ok: true,
          result: { available: true, pid: 4242, processName: 'SquadGame.exe' },
        })),
      },
    ]);
    const result = await getForegroundProcess(runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pid).toBe(4242);
    expect(result.value.processName).toBe('SquadGame.exe');
  });

  it('parses CPU Sets and rejects malformed entries rather than guessing', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: r => r.file === HELPER,
        result: commandOk(JSON.stringify({
          ok: true,
          result: [
            { id: 10, group: 0, logicalProcessorIndex: 0, coreIndex: 0, lastLevelCacheIndex: 1, numaNodeIndex: 0, efficiencyClass: 0, parked: false, allocated: false, allocatedToTargetProcess: false, realTime: false },
            { id: 11, group: 0, logicalProcessorIndex: 1, coreIndex: 0, lastLevelCacheIndex: 1, numaNodeIndex: 0, efficiencyClass: 0, parked: true, allocated: false, allocatedToTargetProcess: false, realTime: false },
            { id: null, group: 0, logicalProcessorIndex: 2, coreIndex: 1, lastLevelCacheIndex: 2, numaNodeIndex: 0, efficiencyClass: 0, parked: false, allocated: false, allocatedToTargetProcess: false, realTime: false },
          ],
        })),
      },
    ]);
    const result = await getSystemCpuSets(runner, { executable: HELPER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.id).toBe(10);
  });
});

describe('WindowsProcessPlacementController', () => {
  it('derives a cache-domain target from observed CPU Sets and detects drift', async () => {
    let calls = 0;
    const runner = new ScriptedCommandRunner([
      {
        match: r => r.file === HELPER,
        result: commandOk(
          ++calls === 1
            ? JSON.stringify({ ok: true, result: { pid: 99, ids: [], explicitlyAssigned: false } })
            : JSON.stringify({
                ok: true,
                result: [
                  { id: 10, group: 0, logicalProcessorIndex: 0, coreIndex: 0, lastLevelCacheIndex: 7, numaNodeIndex: 0, efficiencyClass: 0, parked: false, allocated: false, allocatedToTargetProcess: false, realTime: false },
                  { id: 11, group: 0, logicalProcessorIndex: 1, coreIndex: 0, lastLevelCacheIndex: 7, numaNodeIndex: 0, efficiencyClass: 0, parked: false, allocated: false, allocatedToTargetProcess: false, realTime: false },
                ],
              }),
        ),
      },
    ]);
    const result = await new WindowsProcessPlacementController(runner, { executable: HELPER }).planForCacheDomain(99, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.target).toEqual([10, 11]);
    expect(result.value.before).toEqual([]);
  });
});



describe('CPU Set safety helpers', () => {
  it('allows CPU Set ID zero because Windows IDs are opaque', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: r => r.file === HELPER,
        result: commandOk(JSON.stringify({
          ok: true,
          result: { pid: 1, ids: [0], explicitlyAssigned: true },
        })),
      },
      {
        match: r => r.file === HELPER,
        result: commandOk(JSON.stringify({
          ok: true,
          result: { pid: 1, ids: [0], explicitlyAssigned: true },
        })),
      },
    ]);
    const result = await setProcessDefaultCpuSets(runner, 1, [0], { executable: HELPER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ids).toEqual([0]);
  });
});
