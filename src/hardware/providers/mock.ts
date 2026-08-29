/**
 * Fixture-backed hardware provider.
 *
 * Used for development, for tests, and for the `--simulate` mode of the CLI so
 * that the whole pipeline can be exercised without a physical machine. Its
 * trust level is `mocked`, which propagates into every capability, reading,
 * decision and outcome derived from it. Nothing produced through this provider
 * can be reported as live.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NexusError } from '../../core/errors.js';
import { nexusError } from '../../core/errors.js';
import type { Result } from '../../core/result.js';
import { err, ok } from '../../core/result.js';
import {
  vArray,
  vBoolean,
  vNullable,
  vNumber,
  vObject,
  vOptional,
  vString,
} from '../../core/validate.js';
import { formatIssues } from '../../core/validate.js';
import type { HardwareInventory } from '../../domain/hardware.js';
import type { DiscoveryContext, HardwareProvider } from '../provider.js';
import { hashMachineIdentifier } from '../provider.js';

const nullableString = vNullable(vString({ maxLength: 512 }));
const nullableNumber = vNullable(vNumber());

const fixtureSchema = vObject({
  $comment: vOptional(vString({ maxLength: 2048 })),
  id: vString({ maxLength: 64 }),
  description: vString({ maxLength: 512 }),
  cpu: vObject({
    model: nullableString,
    vendor: nullableString,
    family: nullableString,
    physicalCores: nullableNumber,
    logicalProcessors: nullableNumber,
    baseClockMhz: nullableNumber,
    maxClockMhz: nullableNumber,
    socket: nullableString,
    architecture: nullableString,
    features: vArray(vString({ maxLength: 64 }), { maxItems: 64 }),
  }),
  gpus: vArray(
    vObject({
      index: vNumber({ integer: true, min: 0, max: 16 }),
      model: nullableString,
      vendor: nullableString,
      vramBytes: nullableNumber,
      vramSource: nullableString,
      driverVersion: nullableString,
      driverDateIso: nullableString,
      pnpDeviceId: nullableString,
    }),
    { maxItems: 8 },
  ),
  memory: vObject({
    totalBytes: nullableNumber,
    installedBytes: nullableNumber,
    availableBytes: nullableNumber,
    moduleCount: nullableNumber,
    configuredSpeedMhz: nullableNumber,
    ratedSpeedMhz: nullableNumber,
    memoryType: nullableString,
    availableSource: nullableString,
  }),
  os: vObject({
    platform: vString({ maxLength: 32 }),
    name: nullableString,
    version: nullableString,
    build: nullableString,
    architecture: nullableString,
    kernel: nullableString,
  }),
  storage: vArray(
    vObject({
      id: vString({ maxLength: 128 }),
      model: nullableString,
      busType: nullableString,
      mediaType: nullableString,
      sizeBytes: nullableNumber,
      freeBytes: nullableNumber,
      isSystemDisk: vNullable(vBoolean()),
    }),
    { maxItems: 32 },
  ),
  power: vObject({
    activeSchemeId: nullableString,
    activeSchemeName: nullableString,
    availableSchemes: vArray(
      vObject({ id: vString({ maxLength: 64 }), name: vString({ maxLength: 128 }) }),
      { maxItems: 32 },
    ),
    hasBattery: vNullable(vBoolean()),
  }),
  machineIdSeed: nullableString,
  warnings: vArray(vString({ maxLength: 512 }), { maxItems: 64 }),
});

export type HardwareFixture = ReturnType<typeof fixtureSchema.parse> extends Result<infer T, unknown>
  ? T
  : never;

export const BUILTIN_FIXTURES = ['target-desktop', 'minimal-unknown'] as const;
export type BuiltinFixtureName = (typeof BUILTIN_FIXTURES)[number];

function fixtureDirectory(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
}

export async function loadFixture(nameOrPath: string): Promise<Result<HardwareFixture, NexusError>> {
  const isBuiltin = (BUILTIN_FIXTURES as readonly string[]).includes(nameOrPath);
  const file = isBuiltin ? path.join(fixtureDirectory(), `${nameOrPath}.json`) : path.resolve(nameOrPath);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    return err(nexusError('E_UNAVAILABLE', `hardware fixture not found: ${file}`, undefined, e));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(nexusError('E_INVALID_INPUT', `hardware fixture is not valid JSON: ${file}`, undefined, e));
  }

  const validated = fixtureSchema.parse(parsed);
  if (!validated.ok) {
    return err(
      nexusError('E_INVALID_INPUT', `hardware fixture failed validation: ${file}`, {
        issues: formatIssues(validated.error),
      }),
    );
  }
  return ok(validated.value);
}

export class MockHardwareProvider implements HardwareProvider {
  readonly id: string;
  readonly trust = 'mocked' as const;
  private readonly fixture: HardwareFixture;

  constructor(fixture: HardwareFixture) {
    this.fixture = fixture;
    this.id = `mock:${fixture.id}`;
  }

  static async fromName(name: string): Promise<Result<MockHardwareProvider, NexusError>> {
    const fixture = await loadFixture(name);
    return fixture.ok ? ok(new MockHardwareProvider(fixture.value)) : err(fixture.error);
  }

  supports(): boolean {
    return true;
  }

  async discover(context: DiscoveryContext): Promise<Result<HardwareInventory, NexusError>> {
    const f = this.fixture;
    return ok({
      capturedAtMs: context.clock.now(),
      fidelity: 'mocked',
      provider: this.id,
      machineIdHash: hashMachineIdentifier(f.machineIdSeed),
      cpu: f.cpu,
      gpus: f.gpus,
      memory: f.memory,
      os: f.os,
      storage: f.storage,
      power: f.power,
      warnings: [
        `Inventory came from the "${f.id}" fixture, not from this machine.`,
        ...f.warnings,
      ],
    });
  }
}
