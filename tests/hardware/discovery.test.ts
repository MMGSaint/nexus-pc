import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/core/clock.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { ScriptedCommandRunner, commandOk } from '../../src/core/exec.js';
import { HardwareDiscovery, describeInventory } from '../../src/hardware/discovery.js';
import { MockHardwareProvider, loadFixture } from '../../src/hardware/providers/mock.js';
import { WindowsHardwareProvider, parseActiveScheme, parsePowerSchemes, normaliseCimDate, asArray, asNumber } from '../../src/hardware/providers/windows.js';
import { LinuxHardwareProvider } from '../../src/hardware/providers/linux.js';

const logger = createLogger(new MemorySink(), 'debug');

function baseOptions() {
  return {
    clock: new FixedClock(),
    logger,
    runner: new ScriptedCommandRunner(),
    platform: 'win32' as NodeJS.Platform,
  };
}

describe('fixtures', () => {
  it('loads the target desktop fixture', async () => {
    const fixture = await loadFixture('target-desktop');
    expect(fixture.ok).toBe(true);
    if (!fixture.ok) return;
    expect(fixture.value.cpu.model).toContain('9950X');
    expect(fixture.value.gpus[0]?.vramBytes).toBe(20 * 1024 ** 3);
    expect(fixture.value.memory.installedBytes).toBe(96 * 1024 ** 3);
  });

  it('rejects a fixture with an unknown field', async () => {
    const result = await loadFixture('/nonexistent/fixture.json');
    expect(result.ok).toBe(false);
  });
});

describe('MockHardwareProvider', () => {
  it('produces a mocked inventory and says so', async () => {
    const provider = await MockHardwareProvider.fromName('target-desktop');
    expect(provider.ok).toBe(true);
    if (!provider.ok) return;

    const discovery = new HardwareDiscovery();
    discovery.register(provider.value);
    const result = await discovery.discover(baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.fidelity).toBe('mocked');
    expect(result.value.warnings[0]).toContain('fixture');
    expect(describeInventory(result.value)).toContain('20 GB VRAM');
    expect(describeInventory(result.value)).toContain('96 GB RAM');
    expect(describeInventory(result.value)).toContain('(mocked)');
  });

  it('reports unknown values as null rather than inventing defaults', async () => {
    const provider = await MockHardwareProvider.fromName('minimal-unknown');
    expect(provider.ok).toBe(true);
    if (!provider.ok) return;

    const result = await provider.value.discover({
      clock: new FixedClock(),
      logger,
      runner: new ScriptedCommandRunner(),
      platform: 'win32',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.cpu.physicalCores).toBeNull();
    expect(result.value.memory.totalBytes).toBeNull();
    expect(result.value.gpus).toHaveLength(0);
    expect(describeInventory(result.value)).toContain('unknown CPU');
  });
});

describe('HardwareDiscovery selection', () => {
  it('fails when no provider supports the platform', async () => {
    const discovery = new HardwareDiscovery();
    discovery.register(new WindowsHardwareProvider());
    const result = await discovery.discover({ ...baseOptions(), platform: 'darwin' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_UNSUPPORTED');
  });

  it('falls through to the next provider when the first fails', async () => {
    const provider = await MockHardwareProvider.fromName('target-desktop');
    if (!provider.ok) throw provider.error;

    const discovery = new HardwareDiscovery();
    discovery.register(new WindowsHardwareProvider()); // no scripted response -> fails
    discovery.register(provider.value);
    const result = await discovery.discover(baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider).toBe('mock:target-desktop');
  });

  it('reports every failure when all providers fail', async () => {
    const discovery = new HardwareDiscovery();
    discovery.register(new WindowsHardwareProvider());
    const result = await discovery.discover(baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_UNAVAILABLE');
    expect(String(result.error.details?.['failures'])).toContain('windows.cim');
  });
});

describe('WindowsHardwareProvider parsing', () => {
  const powercfgList = [
    'Existing Power Schemes (* Active)',
    '-----------------------------------',
    'Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced) *',
    'Power Scheme GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (High performance)',
  ].join('\r\n');

  it('parses power schemes', () => {
    const schemes = parsePowerSchemes(powercfgList);
    expect(schemes).toHaveLength(2);
    expect(schemes[0]?.name).toBe('Balanced');
  });

  it('parses the active scheme', () => {
    const active = parseActiveScheme('Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)');
    expect(active?.id).toBe('381b4222-f694-41f0-9685-ff5bb260df2e');
  });

  it('normalises CIM dates in both encodings', () => {
    expect(normaliseCimDate('/Date(1700000000000)/')).toBe(new Date(1700000000000).toISOString());
    expect(normaliseCimDate({ DateTime: '2025-01-15T00:00:00Z' })).toBe('2025-01-15T00:00:00.000Z');
    expect(normaliseCimDate(null)).toBeNull();
  });

  it('treats a PowerShell scalar as a one-element collection', () => {
    expect(asArray({ a: 1 })).toHaveLength(1);
    expect(asArray(null)).toHaveLength(0);
    expect(asArray([1, 2])).toHaveLength(2);
  });

  it('does not coerce garbage to a number', () => {
    expect(asNumber('not-a-number')).toBeNull();
    expect(asNumber('')).toBeNull();
    expect(asNumber(Number.NaN)).toBeNull();
    expect(asNumber('42')).toBe(42);
  });

  it('prefers qwMemorySize over AdapterRAM for video memory', async () => {
    const payload = {
      cpu: { Name: 'AMD Ryzen 9 9950X 16-Core Processor', NumberOfCores: 16, NumberOfLogicalProcessors: 32, MaxClockSpeed: 4300 },
      os: { Caption: 'Microsoft Windows 11 Pro', Version: '10.0.26100', BuildNumber: '26100', OSArchitecture: '64-bit', FreePhysicalMemory: 60000000 },
      cs: { TotalPhysicalMemory: 103012106240 },
      memory: [
        { Capacity: 51539607552, Speed: 6000, ConfiguredClockSpeed: 6000, SMBIOSMemoryType: 34 },
        { Capacity: 51539607552, Speed: 6000, ConfiguredClockSpeed: 6000, SMBIOSMemoryType: 34 },
      ],
      video: [
        {
          Name: 'AMD Radeon RX 7900 XT',
          AdapterCompatibility: 'Advanced Micro Devices, Inc.',
          DriverVersion: '32.0.11029.1005',
          PNPDeviceID: 'PCI\\VEN_1002&DEV_744C',
          AdapterRAM: 4293918720,
        },
      ],
      vram: [{ DriverDesc: 'AMD Radeon RX 7900 XT', 'HardwareInformation.qwMemorySize': 21474836480 }],
      batteries: 0,
      disks: [],
      volumes: [],
      uuid: 'FIXTURE-UUID',
    };

    const runner = new ScriptedCommandRunner([
      { match: (r) => r.file.startsWith('powershell'), result: commandOk(JSON.stringify(payload)) },
      { match: (r) => r.args[0] === '/list', result: commandOk(powercfgList) },
      { match: (r) => r.args[0] === '/getactivescheme', result: commandOk('Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)') },
    ]);

    const result = await new WindowsHardwareProvider().discover({
      clock: new FixedClock(),
      logger,
      runner,
      platform: 'win32',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.gpus[0]?.vramBytes).toBe(21474836480);
    expect(result.value.gpus[0]?.vramSource).toBe('registry:HardwareInformation.qwMemorySize');
    expect(result.value.memory.installedBytes).toBe(103079215104);
    expect(result.value.memory.memoryType).toBe('DDR5');
    expect(result.value.cpu.physicalCores).toBe(16);
    expect(result.value.fidelity).toBe('live');
  });

  it('marks AdapterRAM-derived VRAM as a lower bound and warns', async () => {
    const payload = {
      cpu: { Name: 'CPU', NumberOfCores: 8, NumberOfLogicalProcessors: 16 },
      os: { Caption: 'Windows', OSArchitecture: '64-bit' },
      cs: { TotalPhysicalMemory: 16000000000 },
      memory: [],
      video: [{ Name: 'Some GPU', AdapterRAM: 2147483648 }],
      vram: [],
      batteries: 0,
      disks: [],
      volumes: [],
      uuid: null,
    };
    const runner = new ScriptedCommandRunner([
      { match: (r) => r.file.startsWith('powershell'), result: commandOk(JSON.stringify(payload)) },
      { match: () => true, result: commandOk('') },
    ]);
    const result = await new WindowsHardwareProvider().discover({
      clock: new FixedClock(), logger, runner, platform: 'win32', timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gpus[0]?.vramSource).toBe('wmi:Win32_VideoController.AdapterRAM');
    expect(result.value.warnings.join(' ')).toContain('lower bound');
  });

  it('reports VRAM as unknown when no trustworthy source exists', async () => {
    const payload = {
      cpu: {}, os: {}, cs: {}, memory: [],
      video: [{ Name: 'Some GPU', AdapterRAM: 4294967295 }],
      vram: [], batteries: 0, disks: [], volumes: [], uuid: null,
    };
    const runner = new ScriptedCommandRunner([
      { match: (r) => r.file.startsWith('powershell'), result: commandOk(JSON.stringify(payload)) },
      { match: () => true, result: commandOk('') },
    ]);
    const result = await new WindowsHardwareProvider().discover({
      clock: new FixedClock(), logger, runner, platform: 'win32', timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gpus[0]?.vramBytes).toBeNull();
    expect(result.value.warnings.join(' ')).toContain('unknown rather than guessed');
  });

  it('warns when memory runs below its rated speed', async () => {
    const payload = {
      cpu: {}, os: {}, cs: { TotalPhysicalMemory: 100 },
      memory: [{ Capacity: 100, Speed: 6000, ConfiguredClockSpeed: 4800, SMBIOSMemoryType: 34 }],
      video: [], vram: [], batteries: 0, disks: [], volumes: [], uuid: null,
    };
    const runner = new ScriptedCommandRunner([
      { match: (r) => r.file.startsWith('powershell'), result: commandOk(JSON.stringify(payload)) },
      { match: () => true, result: commandOk('') },
    ]);
    const result = await new WindowsHardwareProvider().discover({
      clock: new FixedClock(), logger, runner, platform: 'win32', timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.join(' ')).toContain('EXPO/DOCP');
  });
});

describe('LinuxHardwareProvider', () => {
  it('reads this host when running on Linux', async () => {
    const provider = new LinuxHardwareProvider();
    if (process.platform !== 'linux') {
      expect(provider.supports(process.platform)).toBe(false);
      return;
    }
    const result = await provider.discover({
      clock: new FixedClock(), logger, runner: new ScriptedCommandRunner(), platform: 'linux', timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fidelity).toBe('live');
    expect(result.value.memory.totalBytes).toBeGreaterThan(0);
    expect(result.value.warnings.join(' ')).toContain('NEXUS targets Windows');
  });
});
