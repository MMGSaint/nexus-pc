import { describe, expect, it } from 'vitest';

import { parseCoreinfoCacheOutput } from '../../src/hardware/coreinfo-topology.js';

describe('Coreinfo X3D topology parser', () => {
  it('identifies the larger L3 cache as the V-Cache domain', () => {
    const output = [
      '******************************** Logical Processor to Cache Map:',
      '**************** Unified Cache   1, Level 3, 96 MB, Assoc 16, LineSize 64',
      '---------------- Unified Cache   2, Level 3, 32 MB, Assoc 16, LineSize 64',
    ].join('\n');
    const parsed = parseCoreinfoCacheOutput(output);
    expect(parsed.available).toBe(true);
    expect(parsed.logicalProcessorCount).toBe(32);
    expect(parsed.vCacheDomain?.sizeBytes).toBe(96 * 1024 ** 2);
    expect(parsed.vCacheDomain?.logicalProcessors.length).toBe(16);
    expect(parsed.standardCacheDomain?.sizeBytes).toBe(32 * 1024 ** 2);
  });

  it('does not invent a V-Cache CCD from one ordinary L3 domain', () => {
    const output = '**************** Unified Cache 1, Level 3, 32 MB, Assoc 16, LineSize 64';
    const parsed = parseCoreinfoCacheOutput(output);
    expect(parsed.vCacheDomain).toBeNull();
  });
});
