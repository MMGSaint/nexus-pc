import { describe, expect, it } from 'vitest';
import { ScriptedCommandRunner, commandOk } from '../../src/core/exec.js';
import { WindowsPowerPlanSandbox } from '../../src/optimizer/power-plan-sandbox.js';

describe('Windows power-plan sandbox', () => {
  it('duplicates, activates, and verifies a separate plan', async () => {
    const runner = new ScriptedCommandRunner([
      { match: r => r.args[0] === '/getactivescheme', result: commandOk('Power Scheme GUID: 11111111-1111-1111-1111-111111111111  (Balanced)') },
      { match: r => r.args[0] === '/duplicatescheme', result: commandOk('Power Scheme GUID: 22222222-2222-2222-2222-222222222222') },
      { match: r => r.args[0] === '/setactive', result: commandOk('') },
      { match: r => r.args[0] === '/getactivescheme', result: commandOk('Power Scheme GUID: 22222222-2222-2222-2222-222222222222  (NEXUS)') },
    ]);
    const result = await new WindowsPowerPlanSandbox(runner).prepare();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.originalGuid).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.value.sandboxGuid).toBe('22222222-2222-2222-2222-222222222222');
    expect(runner.requests.map(r => r.args[0])).toEqual(['/getactivescheme','/duplicatescheme','/setactive','/getactivescheme']);
  });

  it('does not continue after activation fails', async () => {
    const runner = new ScriptedCommandRunner([
      { match: r => r.args[0] === '/getactivescheme', result: commandOk('Power Scheme GUID: 11111111-1111-1111-1111-111111111111') },
      { match: r => r.args[0] === '/duplicatescheme', result: commandOk('22222222-2222-2222-2222-222222222222') },
      { match: r => r.args[0] === '/setactive', result: commandOk('', { code: 1, stderr: 'denied' }) },
      { match: r => r.args[0] === '/delete', result: commandOk('') },
    ]);
    const result = await new WindowsPowerPlanSandbox(runner).prepare();
    expect(result.ok).toBe(false);
    expect(runner.requests.map(r => r.args[0])).toContain('/delete');
  });
});
