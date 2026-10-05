import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/core/clock.js';
import { ScriptedCommandRunner, commandOk } from '../../src/core/exec.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { buildCapabilityProbes } from '../../src/capabilities/probes.js';
import { ActuatorRegistry } from '../../src/optimizer/actuator.js';
import { createProcessEnumerator } from '../../src/process/enumerate.js';
import {
  WindowsForegroundDetector,
  UnsupportedForegroundDetector,
  annotateWithForeground,
  createForegroundDetector,
  parseForegroundPayload,
  probeForegroundDetection,
  WINDOWS_FOREGROUND_SCRIPT,
} from '../../src/process/foreground.js';

const clock = new FixedClock();
const logger = createLogger(new MemorySink(), 'debug');

describe('parseForegroundPayload', () => {
  it('parses a foreground pid and name', () => {
    const parsed = parseForegroundPayload('{"pid":4242,"name":"SquadGame.exe"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ pid: 4242, name: 'SquadGame.exe' });
  });

  it('treats a null pid as no foreground window', () => {
    const parsed = parseForegroundPayload('{"pid":null,"name":null}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toBeNull();
  });

  it('rejects an invalid pid rather than inventing one', () => {
    const parsed = parseForegroundPayload('{"pid":"nope","name":"x.exe"}');
    expect(parsed.ok).toBe(false);
  });
});

describe('annotateWithForeground', () => {
  const processes = [
    { name: 'obs64.exe', pid: 1, cpuPercent: null, workingSetBytes: 1000, isForeground: null },
    { name: 'SquadGame.exe', pid: 42, cpuPercent: null, workingSetBytes: 9_000_000, isForeground: null },
  ];

  it('marks the matching pid and leaves others false', () => {
    const annotated = annotateWithForeground(processes, { pid: 42, name: 'SquadGame.exe' });
    expect(annotated[0]?.isForeground).toBe(false);
    expect(annotated[1]?.isForeground).toBe(true);
  });

  it('leaves isForeground null when there is no foreground window', () => {
    const annotated = annotateWithForeground(processes, null);
    expect(annotated.every((p) => p.isForeground === null)).toBe(true);
  });

  it('does not invent a process row for a pid outside the sample', () => {
    const annotated = annotateWithForeground(processes, { pid: 999, name: 'other.exe' });
    expect(annotated).toHaveLength(2);
    expect(annotated.every((p) => p.isForeground === false)).toBe(true);
  });
});

describe('WindowsForegroundDetector', () => {
  it('runs the fixed PowerShell script through the allowlisted runner', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: (r) => r.file === 'powershell.exe' || r.file.toLowerCase().includes('powershell'),
        result: commandOk('{"pid":42,"name":"SquadGame.exe"}'),
      },
    ]);
    const detector = new WindowsForegroundDetector(runner, clock);
    const result = await detector.detect();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fidelity).toBe('live');
    expect(result.value.backend).toBe('windows.user32.foreground');
    expect(result.value.foreground).toEqual({ pid: 42, name: 'SquadGame.exe' });
    expect(runner.requests[0]?.args).toContain(WINDOWS_FOREGROUND_SCRIPT);
  });

  it('reports unavailable when PowerShell fails', async () => {
    const runner = new ScriptedCommandRunner([]);
    const detector = new WindowsForegroundDetector(runner, clock);
    const result = await detector.detect();
    expect(result.ok).toBe(false);
  });
});

describe('createForegroundDetector', () => {
  it('returns unsupported off Windows', async () => {
    const runner = new ScriptedCommandRunner([]);
    const detector = createForegroundDetector({ platform: 'linux', runner, clock });
    expect(detector).toBeInstanceOf(UnsupportedForegroundDetector);
    const probed = await probeForegroundDetection(detector);
    expect(probed.state).toBe('unsupported');
  });

  it('returns the Windows detector on win32', () => {
    const runner = new ScriptedCommandRunner([]);
    const detector = createForegroundDetector({ platform: 'win32', runner, clock });
    expect(detector).toBeInstanceOf(WindowsForegroundDetector);
  });
});

describe('process.foreground capability probe', () => {
  it('marks process.foreground available when the detector succeeds', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: (r) => r.file.toLowerCase().includes('powershell'),
        result: commandOk('{"pid":7,"name":"notepad.exe"}'),
      },
      {
        match: (r) => r.file === 'tasklist.exe',
        result: commandOk('"notepad.exe","7","Console","1","1,024 K"\r\n'),
      },
    ]);
    const enumerator = createProcessEnumerator({ platform: 'win32', runner, clock });
    const detector = createForegroundDetector({ platform: 'win32', runner, clock });
    const registry = new CapabilityRegistry(clock, logger);
    registry.registerAll(
      buildCapabilityProbes(() => ({
        inventory: null,
        snapshot: null,
        registry: new ActuatorRegistry(),
        actuatorContext: { clock, logger, runner, timeoutMs: 1000 },
        platform: 'win32',
        vesperListening: false,
        processEnumerator: enumerator,
        foregroundDetector: detector,
      })),
    );
    await registry.probeAll(2_000);
    const record = registry.get('process.foreground');
    expect(record?.state).toBe('available');
    expect(record?.fidelity).toBe('live');
    expect(record?.detail).toContain('windows.user32.foreground');
  });

  it('marks process.foreground unsupported on Linux', async () => {
    const runner = new ScriptedCommandRunner([]);
    const enumerator = createProcessEnumerator({ platform: 'linux', runner, clock });
    const detector = createForegroundDetector({ platform: 'linux', runner, clock });
    const registry = new CapabilityRegistry(clock, logger);
    registry.registerAll(
      buildCapabilityProbes(() => ({
        inventory: null,
        snapshot: null,
        registry: new ActuatorRegistry(),
        actuatorContext: { clock, logger, runner, timeoutMs: 1000 },
        platform: 'linux',
        vesperListening: false,
        processEnumerator: enumerator,
        foregroundDetector: detector,
      })),
    );
    await registry.probeAll(2_000);
    const record = registry.get('process.foreground');
    expect(record?.state).toBe('unsupported');
  });
});
