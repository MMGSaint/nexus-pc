import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/core/clock.js';
import { ScriptedCommandRunner, commandOk } from '../../src/core/exec.js';
import {
  LinuxProcessEnumerator,
  WindowsProcessEnumerator,
  UnsupportedProcessEnumerator,
  createProcessEnumerator,
  parseCsvLine,
  parseLinuxVmRss,
  parseTasklistCsv,
  parseWindowsMemUsage,
  probeProcessEnumeration,
  DEFAULT_MAX_PROCESSES,
} from '../../src/process/enumerate.js';
import { CapabilityRegistry } from '../../src/capabilities/registry.js';
import { buildCapabilityProbes } from '../../src/capabilities/probes.js';
import { ActuatorRegistry } from '../../src/optimizer/actuator.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { WorkloadClassifier, signalsFromSnapshot } from '../../src/workload/classifier.js';

const clock = new FixedClock();
const logger = createLogger(new MemorySink(), 'debug');

describe('parseTasklistCsv', () => {
  it('parses quoted tasklist rows including thousands separators in mem usage', () => {
    const csv = [
      '"notepad.exe","1234","Console","1","12,345 K"',
      '"obs64.exe","99","Console","1","1,024 K"',
      '"System Idle Process","0","Services","0","8 K"',
    ].join('\r\n');
    const parsed = parseTasklistCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(3);
    expect(parsed.value[0]).toMatchObject({
      name: 'notepad.exe',
      pid: 1234,
      workingSetBytes: 12_345 * 1024,
      cpuPercent: null,
      isForeground: null,
    });
    expect(parsed.value[1]?.name).toBe('obs64.exe');
    expect(parsed.value[2]?.pid).toBe(0);
  });

  it('rejects a malformed row rather than inventing fields', () => {
    const parsed = parseTasklistCsv('"only-one-field"');
    expect(parsed.ok).toBe(false);
  });
});

describe('CSV / mem helpers', () => {
  it('parses a simple quoted CSV line and escaped quotes', () => {
    expect(parseCsvLine('"a","b""c","d"')).toEqual(['a', 'b"c', 'd']);
    expect(parseCsvLine('"unclosed')).toBeNull();
  });

  it('parses Windows mem usage forms', () => {
    expect(parseWindowsMemUsage('12,345 K')).toBe(12_345 * 1024);
    expect(parseWindowsMemUsage('"1 024 K"')).toBe(1024 * 1024);
    expect(parseWindowsMemUsage('garbage')).toBeNull();
  });

  it('parses Linux VmRSS', () => {
    expect(parseLinuxVmRss('Name:\tbash\nVmRSS:\t\t2048 kB\n')).toBe(2048 * 1024);
    expect(parseLinuxVmRss('Name:\tbash\n')).toBeNull();
  });
});

describe('WindowsProcessEnumerator', () => {
  it('runs allowlisted tasklist with a fixed argument vector', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: (r) => r.file === 'tasklist.exe',
        result: commandOk('"SquadGame.exe","4242","Console","1","500,000 K"\r\n'),
      },
    ]);
    const enumerator = new WindowsProcessEnumerator(runner, clock);
    const result = await enumerator.enumerate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fidelity).toBe('live');
    expect(result.value.backend).toBe('windows.tasklist');
    expect(result.value.processes[0]?.name).toBe('SquadGame.exe');
    expect(runner.requests[0]?.args).toEqual(['/FO', 'CSV', '/NH']);
  });

  it('marks the live foreground process when the native helper is available', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: (r) => r.file === 'tasklist.exe',
        result: commandOk(
          '"SquadGame.exe","4242","Console","1","500,000 K"\r\n"Discord.exe","99","Console","1","1,024 K"\r\n',
        ),
      },
      {
        match: (r) => r.file === 'nexus-native-helper.exe',
        result: commandOk(JSON.stringify({
          ok: true,
          result: { available: true, pid: 4242, processName: 'SquadGame.exe' },
        })),
      },
    ]);
    const result = await new WindowsProcessEnumerator(runner, clock).enumerate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processes.find((p) => p.pid === 4242)?.isForeground).toBe(true);
    expect(result.value.processes.find((p) => p.pid === 99)?.isForeground).toBe(false);
  });

  it('caps and ranks by working set when over the limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => {
      const mem = (i + 1) * 1000;
      return `"p${i}.exe","${i + 1}","Console","1","${mem} K"`;
    }).join('\n');
    const runner = new ScriptedCommandRunner([
      { match: (r) => r.file === 'tasklist.exe', result: commandOk(rows) },
    ]);
    const enumerator = new WindowsProcessEnumerator(runner, clock);
    const result = await enumerator.enumerate({ maxProcesses: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.processes).toHaveLength(2);
    expect(result.value.processes[0]?.name).toBe('p4.exe');
    expect(result.value.processes[1]?.name).toBe('p3.exe');
    expect(result.value.seen).toBe(5);
  });

  it('reports unavailable when tasklist fails', async () => {
    const runner = new ScriptedCommandRunner([]);
    const enumerator = new WindowsProcessEnumerator(runner, clock);
    const result = await enumerator.enumerate();
    expect(result.ok).toBe(false);
  });
});

describe('LinuxProcessEnumerator', () => {
  it('reads a synthetic /proc tree without using a shell', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-proc-'));
    try {
      for (const [pid, comm, rssKb] of [
        ['10', 'node', '4096'],
        ['20', 'obs64', '8192'],
        ['30', 'bash', '1024'],
      ] as const) {
        const dir = path.join(root, pid);
        await mkdir(dir);
        await writeFile(path.join(dir, 'comm'), `${comm}\n`);
        await writeFile(
          path.join(dir, 'status'),
          `Name:\t${comm}\nVmRSS:\t${rssKb} kB\n`,
        );
      }
      await writeFile(path.join(root, 'cpuinfo'), 'not a process');

      const enumerator = new LinuxProcessEnumerator(clock, root);
      const result = await enumerator.enumerate({ maxProcesses: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.fidelity).toBe('live');
      expect(result.value.backend).toBe('linux.procfs.processes');
      expect(result.value.processes.map((p) => p.name)).toEqual(['obs64', 'node', 'bash']);
      expect(result.value.processes[0]?.workingSetBytes).toBe(8192 * 1024);
      expect(result.value.processes[0]?.isForeground).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enumerates the real /proc on Linux and stays live', async () => {
    if (process.platform !== 'linux') return;
    const enumerator = new LinuxProcessEnumerator(clock);
    const result = await enumerator.enumerate({ maxProcesses: 32 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fidelity).toBe('live');
    expect(result.value.processes.length).toBeGreaterThan(0);
    expect(result.value.processes.length).toBeLessThanOrEqual(DEFAULT_MAX_PROCESSES);
    for (const p of result.value.processes) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.pid).not.toBeNull();
    }
  });
});

describe('createProcessEnumerator / unsupported', () => {
  it('selects backends by platform', () => {
    const runner = new ScriptedCommandRunner();
    expect(createProcessEnumerator({ platform: 'linux', runner, clock }).id).toBe(
      'linux.procfs.processes',
    );
    expect(createProcessEnumerator({ platform: 'win32', runner, clock }).id).toBe('windows.tasklist');
    expect(createProcessEnumerator({ platform: 'darwin', runner, clock }).id).toBe(
      'process.unsupported',
    );
  });

  it('marks unsupported platforms honestly', async () => {
    const enumerator = new UnsupportedProcessEnumerator('darwin', clock);
    const probed = await probeProcessEnumeration(enumerator);
    expect(probed.state).toBe('unsupported');
    expect(probed.detail).toContain('darwin');
  });
});

describe('capability probe wiring', () => {
  it('marks process.enumerate available after a successful probe', async () => {
    const runner = new ScriptedCommandRunner([
      {
        match: (r) => r.file === 'tasklist.exe',
        result: commandOk('"node.exe","1","Console","1","1,000 K"\r\n'),
      },
    ]);
    const enumerator = createProcessEnumerator({ platform: 'win32', runner, clock });
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
        runner,
        presentMonPath: null,
        presentMonSha256: null,
      })),
    );
    await registry.probeAll(2_000);
    const record = registry.get('process.enumerate');
    expect(record?.state).toBe('available');
    expect(record?.fidelity).toBe('live');
    expect(record?.detail).toContain('windows.tasklist');
  });

  it('marks process.enumerate unavailable when the backend fails', async () => {
    const runner = new ScriptedCommandRunner([]);
    const enumerator = createProcessEnumerator({ platform: 'win32', runner, clock });
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
        runner,
      })),
    );
    await registry.probeAll(2_000);
    const record = registry.get('process.enumerate');
    expect(record?.state).toBe('unavailable');
    expect(record?.fidelity).toBe('unavailable');
  });
});

describe('classifier integration', () => {
  it('uses enumerated process names as corroborating heuristics', () => {
    const classifier = new WorkloadClassifier();
    const snapshot = {
      timestampMs: clock.now(),
      fidelity: 'live' as const,
      readings: [
        { metric: 'cpu.utilization', value: 40, status: 'ok' },
        { metric: 'gpu.utilization', value: 90, status: 'ok' },
        { metric: 'gpu.vram.used', value: 8 * 1024 ** 3, status: 'ok' },
        { metric: 'gpu.vram.total', value: 20 * 1024 ** 3, status: 'ok' },
        { metric: 'memory.used', value: 20 * 1024 ** 3, status: 'ok' },
        { metric: 'memory.total', value: 96 * 1024 ** 3, status: 'ok' },
      ],
    };
    const withProcesses = classifier.classify(
      signalsFromSnapshot(snapshot, [
        {
          name: 'SquadGame.exe',
          pid: 42,
          cpuPercent: null,
          workingSetBytes: 1_000_000_000,
          isForeground: null,
        },
      ]),
    );
    const without = classifier.classify(signalsFromSnapshot(snapshot, []));
    expect(withProcesses.missingSignals).not.toContain('process.enumerate');
    expect(without.missingSignals).toContain('process.enumerate');
    expect(withProcesses.workload).toBe('gaming');
    const reasons = withProcesses.candidates.find((c) => c.workload === 'gaming')?.reasons.join(' ') ?? '';
    expect(reasons).toContain('heuristic');
  });
});
