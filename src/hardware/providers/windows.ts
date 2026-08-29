/**
 * Windows hardware discovery.
 *
 * Everything here goes through PowerShell + CIM, which is present on every
 * supported Windows install and needs no extra software. Where a classic WMI
 * field is known to be wrong, this provider uses a different source and says
 * which source it used.
 *
 * The most important example is video memory. `Win32_VideoController.AdapterRAM`
 * is a 32-bit field, so it cannot represent more than 4 GiB and reports a
 * wrapped or clamped value on any modern card. The 20 GB on an RX 7900 XT
 * would come back wrong. This provider reads `HardwareInformation.qwMemorySize`
 * from the display adapter's driver key instead, and records `vramSource` so
 * the origin of the number is auditable. When neither source is trustworthy it
 * reports null rather than a plausible-looking wrong number.
 */

import { freemem } from 'node:os';

import type { CommandRunner } from '../../core/exec.js';
import { parsePowerShellJson, runPowerShell } from '../../core/exec.js';
import type { NexusError } from '../../core/errors.js';
import { nexusError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import { isPlainObject } from '../../core/validate.js';
import type {
  GpuInventory,
  HardwareInventory,
  StorageDeviceInventory,
} from '../../domain/hardware.js';
import { EMPTY_CPU, EMPTY_MEMORY, EMPTY_POWER } from '../../domain/hardware.js';
import type { DiscoveryContext, HardwareProvider } from '../provider.js';
import { hashMachineIdentifier } from '../provider.js';

/**
 * `AdapterRAM` is an unsigned 32-bit byte count, so any adapter with 4 GiB or
 * more saturates it. Saturated values are not always exactly 2^32-1 — cards
 * commonly report 4095 MiB (0xFFF00000) or similar — so anything within 64 MiB
 * of the ceiling is treated as an artifact rather than a measurement.
 */
const ADAPTER_RAM_SATURATION_FLOOR = 4 * 1024 ** 3 - 64 * 1024 * 1024;

/**
 * One script, one process. Each section is independently guarded so that a
 * single unavailable class degrades that section to null instead of failing
 * discovery outright.
 */
export const WINDOWS_DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Try-Section([scriptblock]$Body) {
  try { & $Body } catch { $null }
}

$cpu = Try-Section {
  Get-CimInstance -ClassName Win32_Processor |
    Select-Object -First 1 Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors,
      MaxClockSpeed, SocketDesignation, Architecture, Description, Caption
}

$os = Try-Section {
  Get-CimInstance -ClassName Win32_OperatingSystem |
    Select-Object Caption, Version, BuildNumber, OSArchitecture, TotalVisibleMemorySize, FreePhysicalMemory
}

$cs = Try-Section {
  Get-CimInstance -ClassName Win32_ComputerSystem | Select-Object TotalPhysicalMemory
}

# SMBIOSMemoryType is read instead of MemoryType: the CIM MemoryType
# enumeration stops at DDR4, so every DDR5 module reports 0 / Unknown.
$mem = Try-Section {
  Get-CimInstance -ClassName Win32_PhysicalMemory |
    Select-Object Capacity, Speed, ConfiguredClockSpeed, SMBIOSMemoryType, DeviceLocator
}

$video = Try-Section {
  Get-CimInstance -ClassName Win32_VideoController |
    Select-Object Name, AdapterCompatibility, DriverVersion, DriverDate, PNPDeviceID, AdapterRAM, VideoProcessor
}

# qwMemorySize is a 64-bit driver-reported value and is the only in-box source
# that is correct for adapters with more than 4 GiB of dedicated memory.
$vram = Try-Section {
  Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' |
    Select-Object PSChildName, DriverDesc, 'HardwareInformation.qwMemorySize', MatchingDeviceId
}

$battery = Try-Section {
  @(Get-CimInstance -ClassName Win32_Battery).Count
}

$disks = Try-Section {
  Get-CimInstance -Namespace 'root\Microsoft\Windows\Storage' -ClassName MSFT_PhysicalDisk |
    Select-Object DeviceId, FriendlyName, BusType, MediaType, Size
}

$volumes = Try-Section {
  Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' |
    Select-Object DeviceID, Size, FreeSpace
}

$uuid = Try-Section {
  (Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID
}

[pscustomobject]@{
  cpu      = $cpu
  os       = $os
  cs       = $cs
  memory   = @($mem)
  video    = @($video)
  vram     = @($vram)
  batteries= $battery
  disks    = @($disks)
  volumes  = @($volumes)
  uuid     = $uuid
} | ConvertTo-Json -Depth 5 -Compress
`;

export const POWERCFG_LIST_SCRIPT = 'powercfg /list';

export class WindowsHardwareProvider implements HardwareProvider {
  readonly id = 'windows.cim';
  readonly trust = 'live' as const;

  supports(platform: NodeJS.Platform): boolean {
    return platform === 'win32';
  }

  async discover(context: DiscoveryContext): Promise<Result<HardwareInventory, NexusError>> {
    const warnings: string[] = [];
    const response = await runPowerShell(context.runner, WINDOWS_DISCOVERY_SCRIPT, {
      timeoutMs: context.timeoutMs,
    });
    if (!response.ok) return err(response.error);
    if (response.value.timedOut) {
      return err(nexusError('E_TIMEOUT', 'Windows hardware discovery timed out'));
    }
    if (response.value.code !== 0 && response.value.stdout.trim() === '') {
      return err(
        nexusError('E_UNAVAILABLE', 'PowerShell discovery produced no output', {
          exitCode: response.value.code,
          stderr: response.value.stderr.slice(0, 400),
        }),
      );
    }

    const parsed = parsePowerShellJson(response.value.stdout);
    if (!parsed.ok) return err(parsed.error);
    if (!isPlainObject(parsed.value)) {
      return err(nexusError('E_IO', 'discovery output was not an object'));
    }
    const raw = parsed.value;

    const power = await this.discoverPower(context.runner, context.timeoutMs, warnings);
    const availablePhysical = Number.isFinite(freemem()) ? freemem() : null;

    const cpuRaw = asObject(raw['cpu']);
    const osRaw = asObject(raw['os']);
    const csRaw = asObject(raw['cs']);
    const memoryRaw = asArray(raw['memory']);
    const videoRaw = asArray(raw['video']);
    const vramRaw = asArray(raw['vram']);
    const disksRaw = asArray(raw['disks']);
    const volumesRaw = asArray(raw['volumes']);

    if (!cpuRaw) warnings.push('Win32_Processor returned nothing; CPU details are unavailable.');
    if (!osRaw) warnings.push('Win32_OperatingSystem returned nothing; OS details are unavailable.');
    if (videoRaw.length === 0) warnings.push('Win32_VideoController returned nothing; no GPU was detected.');

    const installedBytes = memoryRaw.length > 0
      ? memoryRaw.reduce<number>((sum, m) => sum + (asNumber(asObject(m)?.['Capacity']) ?? 0), 0) || null
      : null;
    const totalBytes = asNumber(csRaw?.['TotalPhysicalMemory']);
    const freeKb = asNumber(osRaw?.['FreePhysicalMemory']);
    const firstModule = memoryRaw.length > 0 ? asObject(memoryRaw[0]) : null;
    // `Speed` is the module's rated (SPD/EXPO) speed; `ConfiguredClockSpeed`
    // is what it is actually running at. Both are in MT/s despite the CIM
    // documentation labelling the units as nanoseconds.
    const ratedSpeed = asNumber(firstModule?.['Speed']);
    const configuredSpeed = asNumber(firstModule?.['ConfiguredClockSpeed']) ?? ratedSpeed;
    if (ratedSpeed !== null && configuredSpeed !== null && configuredSpeed < ratedSpeed) {
      warnings.push(
        `Memory is running at ${configuredSpeed} MT/s but the modules are rated for ${ratedSpeed} MT/s — the EXPO/DOCP profile does not appear to be applied in firmware.`,
      );
    }
    const memoryType = smbiosMemoryTypeName(asNumber(firstModule?.['SMBIOSMemoryType']));

    if (installedBytes !== null && totalBytes !== null && installedBytes > 0) {
      const ratio = totalBytes / installedBytes;
      if (ratio < 0.9) {
        warnings.push(
          `Usable memory (${(totalBytes / 1024 ** 3).toFixed(1)} GiB) is well below installed (${(installedBytes / 1024 ** 3).toFixed(1)} GiB); some memory may be reserved or a module may not be enumerated.`,
        );
      }
    }

    const gpus = videoRaw.map((entry, index) => this.buildGpu(asObject(entry), vramRaw, index, warnings));

    const storage: StorageDeviceInventory[] = disksRaw.map((entry) => {
      const d = asObject(entry);
      return {
        id: String(d?.['DeviceId'] ?? `disk-${String(d?.['FriendlyName'] ?? 'unknown')}`),
        model: asString(d?.['FriendlyName']),
        busType: busTypeName(asNumber(d?.['BusType'])),
        mediaType: mediaTypeName(asNumber(d?.['MediaType'])),
        sizeBytes: asNumber(d?.['Size']),
        freeBytes: null,
        isSystemDisk: null,
      };
    });

    const systemVolume = volumesRaw
      .map((v) => asObject(v))
      .find((v) => String(v?.['DeviceID'] ?? '').toUpperCase() === 'C:');
    if (systemVolume && storage.length > 0) {
      const first = storage[0];
      if (first) {
        storage[0] = { ...first, freeBytes: asNumber(systemVolume['FreeSpace']), isSystemDisk: true };
      }
    }

    const inventory: HardwareInventory = {
      capturedAtMs: context.clock.now(),
      fidelity: 'live',
      provider: this.id,
      machineIdHash: hashMachineIdentifier(asString(raw['uuid'])),
      cpu: {
        ...EMPTY_CPU,
        model: asString(cpuRaw?.['Name'])?.trim() ?? null,
        vendor: asString(cpuRaw?.['Manufacturer']),
        family: asString(cpuRaw?.['Description']),
        physicalCores: asNumber(cpuRaw?.['NumberOfCores']),
        logicalProcessors: asNumber(cpuRaw?.['NumberOfLogicalProcessors']),
        // MaxClockSpeed is the firmware-reported nominal maximum, not a live
        // clock. Live clocks come from telemetry, never from here.
        baseClockMhz: null,
        maxClockMhz: asNumber(cpuRaw?.['MaxClockSpeed']),
        socket: asString(cpuRaw?.['SocketDesignation']),
        architecture: asString(osRaw?.['OSArchitecture']),
        features: [],
      },
      gpus,
      memory: {
        ...EMPTY_MEMORY,
        totalBytes,
        installedBytes,
        // `os.freemem()` on Windows is GlobalMemoryStatusEx().ullAvailPhys,
        // which is what Task Manager calls "Available" and includes the
        // reclaimable standby list. Win32_OperatingSystem.FreePhysicalMemory
        // counts only free and zeroed pages and reads alarmingly low on a
        // machine with a warm file cache, so it is used only as a fallback.
        availableBytes: availablePhysical ?? (freeKb === null ? null : freeKb * 1024),
        availableSource: availablePhysical !== null ? 'os.freemem' : freeKb === null ? null : 'wmi:FreePhysicalMemory',
        moduleCount: memoryRaw.length > 0 ? memoryRaw.length : null,
        configuredSpeedMhz: configuredSpeed,
        ratedSpeedMhz: ratedSpeed,
        memoryType,
      },
      os: {
        platform: 'win32',
        name: asString(osRaw?.['Caption'])?.trim() ?? null,
        version: asString(osRaw?.['Version']),
        build: asString(osRaw?.['BuildNumber']),
        architecture: asString(osRaw?.['OSArchitecture']),
        kernel: null,
      },
      storage,
      power: {
        ...power,
        hasBattery: (asNumber(raw['batteries']) ?? 0) > 0,
      },
      warnings,
    };

    return ok(inventory);
  }

  private buildGpu(
    entry: Record<string, unknown> | null,
    vramEntries: readonly unknown[],
    index: number,
    warnings: string[],
  ): GpuInventory {
    const name = asString(entry?.['Name'])?.trim() ?? null;
    const pnp = asString(entry?.['PNPDeviceID']);

    let vramBytes: number | null = null;
    let vramSource: string | null = null;

    const match = vramEntries
      .map((v) => asObject(v))
      .find((v) => {
        if (!v) return false;
        const desc = asString(v['DriverDesc']);
        if (desc && name && desc.trim() === name) return true;
        const matching = asString(v['MatchingDeviceId']);
        if (matching && pnp && pnp.toUpperCase().includes(matching.toUpperCase().split('&')[0] ?? '')) return true;
        return false;
      });

    const qw = asNumber(match?.['HardwareInformation.qwMemorySize']);
    if (qw !== null && qw > 0) {
      vramBytes = qw;
      vramSource = 'registry:HardwareInformation.qwMemorySize';
    } else {
      const adapterRam = asNumber(entry?.['AdapterRAM']);
      if (adapterRam !== null && adapterRam > 0 && adapterRam < ADAPTER_RAM_SATURATION_FLOOR) {
        vramBytes = adapterRam;
        vramSource = 'wmi:Win32_VideoController.AdapterRAM';
        warnings.push(
          `GPU ${index}: dedicated memory came from AdapterRAM, which cannot represent more than 4 GiB. Treat ${(adapterRam / 1024 ** 3).toFixed(1)} GiB as a lower bound.`,
        );
      } else {
        warnings.push(
          `GPU ${index}: dedicated memory could not be read from a trustworthy source; reported as unknown rather than guessed.`,
        );
      }
    }

    return {
      index,
      model: name,
      vendor: asString(entry?.['AdapterCompatibility']),
      vramBytes,
      vramSource,
      driverVersion: asString(entry?.['DriverVersion']),
      driverDateIso: normaliseCimDate(entry?.['DriverDate']),
      pnpDeviceId: pnp,
    };
  }

  private async discoverPower(
    runner: CommandRunner,
    timeoutMs: number,
    warnings: string[],
  ): Promise<HardwareInventory['power']> {
    const listed = await runner.run({ file: 'powercfg.exe', args: ['/list'], timeoutMs });
    const active = await runner.run({ file: 'powercfg.exe', args: ['/getactivescheme'], timeoutMs });

    if (!listed.ok || !active.ok) {
      warnings.push('powercfg was not readable; power scheme details are unavailable.');
      return EMPTY_POWER;
    }

    const schemes = parsePowerSchemes(listed.value.stdout);
    const activeScheme = parseActiveScheme(active.value.stdout);

    return {
      activeSchemeId: activeScheme?.id ?? null,
      activeSchemeName: activeScheme?.name ?? null,
      availableSchemes: schemes,
      hasBattery: null,
    };
  }
}

/* --------------------------------------------------------------- parsing */

const SCHEME_LINE = /Power Scheme GUID:\s*([0-9a-fA-F-]{36})\s*\(([^)]*)\)/;

export function parsePowerSchemes(stdout: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = SCHEME_LINE.exec(line);
    if (m && m[1] && m[2] !== undefined) out.push({ id: m[1].toLowerCase(), name: m[2].trim() });
  }
  return out;
}

export function parseActiveScheme(stdout: string): { id: string; name: string } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = SCHEME_LINE.exec(line);
    if (m && m[1] && m[2] !== undefined) return { id: m[1].toLowerCase(), name: m[2].trim() };
  }
  return null;
}

/** CIM dates arrive either as an ISO string or as `/Date(…)/` from ConvertTo-Json. */
export function normaliseCimDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const epoch = /\/Date\((-?\d+)\)\//.exec(value);
    if (epoch?.[1]) {
      const ms = Number(epoch[1]);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (isPlainObject(value)) {
    const inner = value['DateTime'];
    if (typeof inner === 'string') return normaliseCimDate(inner);
  }
  return null;
}

export function smbiosMemoryTypeName(code: number | null): string | null {
  if (code === null) return null;
  const map: Record<number, string> = { 24: 'DDR3', 26: 'DDR4', 34: 'DDR5', 35: 'LPDDR5' };
  return map[code] ?? `smbios-type-${code}`;
}

function busTypeName(code: number | null): string | null {
  if (code === null) return null;
  const map: Record<number, string> = {
    1: 'SCSI', 2: 'ATAPI', 3: 'ATA', 4: '1394', 5: 'SSA', 6: 'Fibre Channel',
    7: 'USB', 8: 'RAID', 9: 'iSCSI', 10: 'SAS', 11: 'SATA', 12: 'SD',
    13: 'MMC', 15: 'File Backed Virtual', 17: 'NVMe',
  };
  return map[code] ?? `code-${code}`;
}

function mediaTypeName(code: number | null): string | null {
  if (code === null) return null;
  const map: Record<number, string> = { 0: 'Unspecified', 3: 'HDD', 4: 'SSD', 5: 'SCM' };
  return map[code] ?? `code-${code}`;
}

/* ------------------------------------------------------------- coercion */

export function asObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

export function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  // PowerShell collapses a one-element collection to a scalar.
  return [value];
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (isPlainObject(value) && typeof value['Value'] === 'number') return value['Value'];
  return null;
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}
