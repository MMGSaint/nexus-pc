import { describe, expect, it } from 'vitest';

import { captureWindowsStability, diffWindowsStability } from '../../src/stability/windows-event-oracle.js';
import { ScriptedCommandRunner, commandOk } from '../../src/core/exec.js';

describe('Windows stability oracle', () => {
  it('parses the built-in Event Log query response', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: (request) => request.file.toLowerCase().includes('powershell'),
        result: commandOk(JSON.stringify({ whea: 1, displayTdr: 0, appCrashes: 2, werEvents: 2 })),
      },
    ]);

    const result = await captureWindowsStability(runner, Date.now() - 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.whea).toBe(1);
    expect(result.value.appCrashes).toBe(2);
  });

  it('treats only post-baseline incident increases as instability', () => {
    const delta = diffWindowsStability(
      {
        capturedAtMs: 1,
        available: true,
        whea: 2,
        displayTdr: 3,
        appCrashes: 4,
        werEvents: 5,
        totalErrors: 9,
        detail: 'before',
      },
      {
        capturedAtMs: 2,
        available: true,
        whea: 2,
        displayTdr: 4,
        appCrashes: 5,
        werEvents: 9,
        totalErrors: 11,
        detail: 'after',
      },
    );

    expect(delta).toEqual({
      whea: 0,
      displayTdr: 1,
      appCrashes: 1,
      werEvents: 4,
      totalErrors: 2,
      unstable: true,
    });
  });
});
