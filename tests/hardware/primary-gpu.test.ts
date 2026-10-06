import { describe, expect, it } from 'vitest';

import { selectPrimaryGpu } from '../../src/hardware/primary-gpu.js';

describe('primary GPU selection', () => {
  it('does not assume GPU index zero is the gaming adapter', () => {
    const gpu = selectPrimaryGpu([
      {
        index: 0,
        model: 'AMD Radeon Graphics',
        vendor: 'AMD',
        vramBytes: null,
        vramSource: null,
        driverVersion: null,
        driverDateIso: null,
        pnpDeviceId: null,
      },
      {
        index: 1,
        model: 'AMD Radeon RX 7900 XT',
        vendor: 'AMD',
        vramBytes: 20 * 1024 ** 3,
        vramSource: 'test',
        driverVersion: null,
        driverDateIso: null,
        pnpDeviceId: null,
      },
    ]);
    expect(gpu?.model).toBe('AMD Radeon RX 7900 XT');
  });

  it('returns null only when the inventory is actually empty', () => {
    expect(selectPrimaryGpu([])).toBeNull();
  });
});
