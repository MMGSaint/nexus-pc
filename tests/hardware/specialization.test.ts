import { describe, expect, it } from 'vitest';

import type { HardwareInventory } from '../../src/domain/hardware.js';
import { BUILTIN_PROFILES } from '../../src/profiles/builtin.js';
import {
  PRIMARY_TARGET,
  automaticProfileGuard,
  specializeTarget,
} from '../../src/hardware/specialization.js';

function inventory(overrides: Partial<HardwareInventory['cpu']> = {}): HardwareInventory {
  return {
    capturedAtMs: 1,
    fidelity: 'live',
    provider: 'test',
    machineIdHash: 'test',
    cpu: {
      model: 'AMD Ryzen 9 9950X3D 16-Core Processor',
      vendor: 'AuthenticAMD',
      family: null,
      physicalCores: 16,
      logicalProcessors: 32,
      baseClockMhz: null,
      maxClockMhz: 5700,
      socket: 'AM5',
      architecture: '64-bit',
      features: [],
      ...overrides,
    },
    gpus: [
      {
        index: 0,
        model: 'AMD Radeon RX 7900 XT',
        vendor: 'AMD',
        vramBytes: 20 * 1024 ** 3,
        vramSource: 'test',
        driverVersion: null,
        driverDateIso: null,
        pnpDeviceId: null,
      },
    ],
    memory: {
      totalBytes: 95.96 * 1024 ** 3,
      installedBytes: 96 * 1024 ** 3,
      availableBytes: 80 * 1024 ** 3,
      moduleCount: 2,
      configuredSpeedMhz: 6000,
      ratedSpeedMhz: 6000,
      memoryType: 'DDR5',
      availableSource: 'test',
    },
    os: {
      platform: 'win32',
      name: 'Windows 11',
      version: null,
      build: null,
      architecture: '64-bit',
      kernel: null,
    },
    storage: [],
    power: {
      activeSchemeId: null,
      activeSchemeName: null,
      availableSchemes: [],
      hasBattery: false,
    },
    warnings: [],
  };
}

describe('private target specialization', () => {
  it('recognizes the exact primary target', () => {
    const match = specializeTarget(inventory());
    expect(match.id).toBe(PRIMARY_TARGET.id);
    expect(match.matched).toBe(true);
    expect(match.exactHardwareMatch).toBe(true);
    expect(match.x3dSchedulingSensitive).toBe(true);
  });

  it('keeps X3D strategy active even when the GPU or RAM differs', () => {
    const match = specializeTarget(
      inventory({
        model: 'AMD Ryzen 9 9950X3D',
      }),
    );
    expect(match.id).toBe('x3d-9950x3d');
    expect(match.exactHardwareMatch).toBe(false);
    expect(match.x3dSchedulingSensitive).toBe(true);
  });

  it('does not classify a non-X3D CPU as the private target', () => {
    const match = specializeTarget(inventory({ model: 'AMD Ryzen 9 9950X 16-Core Processor' }));
    expect(match.id).toBe('generic');
    expect(match.matched).toBe(false);
    expect(match.x3dSchedulingSensitive).toBe(false);
  });

  it('blocks automatic generic gaming when it contains deferred X3D controls', () => {
    const gaming = BUILTIN_PROFILES.find((profile) => profile.id === 'gaming');
    expect(gaming).toBeDefined();
    if (!gaming) return;

    const reason = automaticProfileGuard(gaming, specializeTarget(inventory()));
    expect(reason).toContain('power.processor.core_parking_min');
    expect(reason).toContain('power.processor.min_state');
  });

  it('does not block a profile that avoids the deferred controls', () => {
    const gaming = BUILTIN_PROFILES.find((profile) => profile.id === 'gaming');
    expect(gaming).toBeDefined();
    if (!gaming) return;

    const safeProfile = {
      ...gaming,
      settings: gaming.settings.filter(
        (setting) =>
          setting.control !== 'power.processor.core_parking_min' &&
          setting.control !== 'power.processor.min_state',
      ),
    };
    expect(automaticProfileGuard(safeProfile, specializeTarget(inventory()))).toBeNull();
  });
});
