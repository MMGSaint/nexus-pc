/**
 * Hardware inventory produced by discovery.
 *
 * Every field is nullable. Discovery on a machine whose interfaces are
 * partially unavailable produces a partial inventory with explicit nulls, not
 * plausible-looking defaults.
 */

import type { Fidelity } from '../core/fidelity.js';

export interface CpuInventory {
  readonly model: string | null;
  readonly vendor: string | null;
  readonly family: string | null;
  readonly physicalCores: number | null;
  readonly logicalProcessors: number | null;
  /** Nominal/base clock in MHz as reported by firmware. Not a live clock. */
  readonly baseClockMhz: number | null;
  readonly maxClockMhz: number | null;
  readonly socket: string | null;
  readonly architecture: string | null;
  /** e.g. "avx512", "smt". Empty when the interface could not report them. */
  readonly features: readonly string[];
}

export interface GpuInventory {
  readonly index: number;
  readonly model: string | null;
  readonly vendor: string | null;
  /**
   * Dedicated video memory in bytes.
   *
   * Note: on Windows the classic WMI `Win32_VideoController.AdapterRAM` field
   * is a signed 32-bit value and cannot represent more than 4 GiB, so it is
   * never used as the source for this field. See docs/hardware-detection.md.
   */
  readonly vramBytes: number | null;
  readonly vramSource: string | null;
  readonly driverVersion: string | null;
  readonly driverDateIso: string | null;
  readonly pnpDeviceId: string | null;
}

export interface MemoryInventory {
  /** Memory the OS reports as usable. Slightly below installed on most PCs. */
  readonly totalBytes: number | null;
  /**
   * Sum of the installed module capacities — the figure a user recognises as
   * "96 GB". Kept separate from `totalBytes` because they legitimately differ
   * and conflating them makes a correct reading look like a bug.
   */
  readonly installedBytes: number | null;
  readonly availableBytes: number | null;
  readonly moduleCount: number | null;
  /** Speed the modules are actually running at, in MT/s. */
  readonly configuredSpeedMhz: number | null;
  /** Speed the modules are rated for (SPD/EXPO), in MT/s. */
  readonly ratedSpeedMhz: number | null;
  /** e.g. "DDR5". Read from SMBIOSMemoryType, not the stale MemoryType enum. */
  readonly memoryType: string | null;
  /** Where `availableBytes` came from, since Windows exposes several figures. */
  readonly availableSource: string | null;
}

export interface OsInventory {
  readonly platform: string;
  readonly name: string | null;
  readonly version: string | null;
  readonly build: string | null;
  readonly architecture: string | null;
  readonly kernel: string | null;
}

export interface StorageDeviceInventory {
  readonly id: string;
  readonly model: string | null;
  readonly busType: string | null;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly freeBytes: number | null;
  readonly isSystemDisk: boolean | null;
}

export interface PowerInventory {
  /** GUID of the active Windows power scheme, when readable. */
  readonly activeSchemeId: string | null;
  readonly activeSchemeName: string | null;
  readonly availableSchemes: readonly { readonly id: string; readonly name: string }[];
  /** Desktop machines report null rather than a fabricated battery. */
  readonly hasBattery: boolean | null;
}

export interface HardwareInventory {
  readonly capturedAtMs: number;
  readonly fidelity: Fidelity;
  /** Identifier of the provider that produced the inventory. */
  readonly provider: string;
  readonly machineIdHash: string | null;
  readonly cpu: CpuInventory;
  readonly gpus: readonly GpuInventory[];
  readonly memory: MemoryInventory;
  readonly os: OsInventory;
  readonly storage: readonly StorageDeviceInventory[];
  readonly power: PowerInventory;
  /** Non-fatal problems encountered during discovery. */
  readonly warnings: readonly string[];
}

export const EMPTY_CPU: CpuInventory = Object.freeze({
  model: null,
  vendor: null,
  family: null,
  physicalCores: null,
  logicalProcessors: null,
  baseClockMhz: null,
  maxClockMhz: null,
  socket: null,
  architecture: null,
  features: Object.freeze([]),
});

export const EMPTY_MEMORY: MemoryInventory = Object.freeze({
  totalBytes: null,
  installedBytes: null,
  availableBytes: null,
  moduleCount: null,
  configuredSpeedMhz: null,
  ratedSpeedMhz: null,
  memoryType: null,
  availableSource: null,
});

export const EMPTY_POWER: PowerInventory = Object.freeze({
  activeSchemeId: null,
  activeSchemeName: null,
  availableSchemes: Object.freeze([]),
  hasBattery: null,
});

export function gibibytes(bytes: number | null): number | null {
  return bytes === null ? null : bytes / 1024 ** 3;
}
