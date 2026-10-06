/**
 * Baseline capture.
 *
 * A baseline is the answer to "what did this machine look like before NEXUS
 * touched anything?" — the hardware inventory, which capabilities were real,
 * what every writable control was set to, and how the machine behaved over an
 * observation window.
 *
 * Capture is strictly read-only. It calls `read` on adapters and never `write`;
 * there is no code path here that mutates a setting. That property is asserted
 * by the tests, because a baseline that changed the thing it was measuring
 * would be worse than no baseline at all.
 *
 * A baseline is persisted and auditable: it is what a rollback aims at, what a
 * measurement compares against, and what a human looks at when something went
 * wrong six weeks later.
 */

import path from 'node:path';

import type { Clock } from '../core/clock.js';
import type { NexusError } from '../core/errors.js';
import { nexusError } from '../core/errors.js';
import type { Fidelity } from '../core/fidelity.js';
import { combineFidelity } from '../core/fidelity.js';
import { listFiles, readJson, removeFile, writeJson } from '../core/fsx.js';
import type { IdSource } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { NexusPaths } from '../core/paths.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { vArray, vBoolean, vNullable, vNumber, vObject, vOptional, vString, vUnion, vUnknown } from '../core/validate.js';
import type { CapabilityId, CapabilityRecord } from '../domain/capability.js';
import type { ControlId, ControlState, ControlValue } from '../domain/control.js';
import type { HardwareInventory } from '../domain/hardware.js';
import type { TelemetrySnapshot, TelemetrySummary } from '../domain/telemetry.js';
import type { WorkloadClassification } from '../domain/workload.js';
import type { ActuatorContext } from '../optimizer/actuator.js';
import type { ActuatorRegistry } from '../optimizer/actuator.js';
import { writableControls } from '../safety/controls.js';
import { summarize } from '../telemetry/summary.js';

export interface Baseline {
  readonly id: string;
  readonly capturedAtMs: number;
  readonly sessionId: string;
  readonly nexusVersion: string;
  readonly machineIdHash: string | null;
  /** Weakest fidelity across every component of the baseline. */
  readonly fidelity: Fidelity;
  readonly inventory: HardwareInventory;
  readonly capabilities: readonly CapabilityRecord[];
  readonly controlStates: readonly ControlState[];
  readonly telemetry: TelemetrySummary;
  readonly workload: WorkloadClassification | null;
  /** Signed display driver identity captured with the baseline, when available. */
  readonly driverVersion?: string | null;
  /** Fraction of writable controls whose value was successfully read, 0..1. */
  readonly controlCoverage: number;
  readonly notes: readonly string[];
}

const controlValueSchema = vUnion(vString({ maxLength: 256 }), vNumber(), vBoolean());

/**
 * Persisted baselines are read back with a permissive schema for the nested
 * inventory/telemetry documents: those are NEXUS's own output, and rejecting a
 * baseline written by a slightly older version would throw away exactly the
 * historical evidence a baseline exists to preserve. The fields NEXUS acts on
 * are validated strictly.
 */
const baselineSchema = vObject({
  id: vString({ maxLength: 64 }),
  capturedAtMs: vNumber({ min: 0 }),
  sessionId: vString({ maxLength: 64 }),
  nexusVersion: vString({ maxLength: 32 }),
  machineIdHash: vNullable(vString({ maxLength: 64 })),
  fidelity: vString({ maxLength: 16 }),
  inventory: vUnknown(),
  capabilities: vArray(vUnknown(), { maxItems: 256 }),
  controlStates: vArray(
    vObject({
      control: vString({ maxLength: 128 }),
      value: vNullable(controlValueSchema),
      readable: vBoolean(),
      capturedAtMs: vNumber({ min: 0 }),
      source: vString({ maxLength: 128 }),
      note: vOptional(vString({ maxLength: 512 })),
    }),
    { maxItems: 128 },
  ),
  telemetry: vUnknown(),
  workload: vUnknown(),
  driverVersion: vOptional(vNullable(vString({ maxLength: 64 }))),
  controlCoverage: vNumber({ min: 0, max: 1 }),
  notes: vArray(vString({ maxLength: 512 }), { maxItems: 64 }),
});

export interface BaselineCaptureInput {
  readonly inventory: HardwareInventory;
  readonly capabilities: ReadonlyMap<CapabilityId, CapabilityRecord>;
  readonly snapshots: readonly TelemetrySnapshot[];
  readonly workload: WorkloadClassification | null;
  readonly driverVersion?: string | null;
  readonly context: ActuatorContext;
  readonly notes?: readonly string[];
}

export interface BaselineStoreOptions {
  readonly paths: NexusPaths;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ids: IdSource;
  readonly sessionId: string;
  readonly nexusVersion: string;
  readonly registry: ActuatorRegistry;
  readonly maxBaselines?: number;
}

export class BaselineStore {
  private readonly options: BaselineStoreOptions;
  private readonly maxBaselines: number;

  constructor(options: BaselineStoreOptions) {
    this.options = options;
    this.maxBaselines = options.maxBaselines ?? 20;
  }

  /**
   * Capture a baseline. Read-only by construction: the only adapter method
   * this function can reach is `read`.
   */
  async capture(input: BaselineCaptureInput): Promise<Result<Baseline, NexusError>> {
    const notes = [...(input.notes ?? [])];
    const controlStates: ControlState[] = [];
    const candidates = writableControls();
    let readable = 0;

    for (const descriptor of candidates) {
      const adapter = this.options.registry.get(descriptor.id);
      if (!adapter) {
        controlStates.push({
          control: descriptor.id,
          value: null,
          readable: false,
          capturedAtMs: this.options.clock.now(),
          source: 'none',
          note: 'no adapter is registered for this control on this machine',
        });
        continue;
      }
      const value = await adapter.read(input.context);
      if (!value.ok) {
        controlStates.push({
          control: descriptor.id,
          value: null,
          readable: false,
          capturedAtMs: this.options.clock.now(),
          source: adapter.id,
          note: `read failed: ${value.error.message}`,
        });
        continue;
      }
      if (value.value !== null) readable += 1;
      controlStates.push({
        control: descriptor.id,
        value: value.value,
        readable: value.value !== null,
        capturedAtMs: this.options.clock.now(),
        source: adapter.id,
      });
    }

    const telemetry = summarize(input.snapshots);
    const capabilities = [...input.capabilities.values()];

    if (input.snapshots.length === 0) {
      notes.push('No telemetry was captured during this baseline; behavioural comparison will not be possible.');
    }
    if (readable === 0 && candidates.length > 0) {
      notes.push('No writable control could be read, so this baseline cannot support a rollback.');
    }

    const fidelity = combineFidelity(
      input.inventory.fidelity,
      telemetry.fidelity,
      ...capabilities.filter((c) => c.state === 'available' || c.state === 'mocked').map((c) => c.fidelity),
    );

    const baseline: Baseline = {
      id: this.options.ids.next('base'),
      capturedAtMs: this.options.clock.now(),
      sessionId: this.options.sessionId,
      nexusVersion: this.options.nexusVersion,
      machineIdHash: input.inventory.machineIdHash,
      fidelity,
      inventory: input.inventory,
      capabilities,
      controlStates,
      telemetry,
      workload: input.workload,
      ...(input.driverVersion === undefined ? {} : { driverVersion: input.driverVersion }),
      controlCoverage: candidates.length === 0 ? 0 : readable / candidates.length,
      notes,
    };

    const written = await writeJson(this.file(baseline.id), baseline, { fsyncData: true });
    if (!written.ok) return err(written.error);
    await writeJson(path.join(this.options.paths.baselines, 'latest.json'), { id: baseline.id });
    await this.prune();

    this.options.logger.info('baseline captured', {
      id: baseline.id,
      fidelity,
      controlCoverage: Number(baseline.controlCoverage.toFixed(2)),
      telemetrySamples: telemetry.sampleCount,
    });
    return ok(baseline);
  }

  async load(id: string): Promise<Result<Baseline, NexusError>> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return err(nexusError('E_INVALID_INPUT', `invalid baseline id: ${id}`));
    }
    const parsed = await readJson(this.file(id), baselineSchema);
    return parsed.ok ? ok(parsed.value as unknown as Baseline) : err(parsed.error);
  }

  async latest(): Promise<Result<Baseline, NexusError>> {
    const pointer = await readJson(
      path.join(this.options.paths.baselines, 'latest.json'),
      vObject({ id: vString({ maxLength: 64 }) }),
    );
    if (!pointer.ok) return err(pointer.error);
    return this.load(pointer.value.id);
  }

  async exists(): Promise<boolean> {
    return (await this.latest()).ok;
  }

  async list(): Promise<readonly string[]> {
    const files = await listFiles(this.options.paths.baselines);
    return files
      .filter((f) => f.endsWith('.json') && f !== 'latest.json')
      .map((f) => f.slice(0, -5))
      .sort();
  }

  private file(id: string): string {
    return path.join(this.options.paths.baselines, `${id}.json`);
  }

  /**
   * Bounded retention. Baselines are recovery artifacts, so the newest is
   * never removed and the floor is enforced before any deletion happens.
   */
  private async prune(): Promise<void> {
    const ids = await this.list();
    if (ids.length <= this.maxBaselines) return;

    const dated: { id: string; capturedAtMs: number }[] = [];
    for (const id of ids) {
      const loaded = await this.load(id);
      dated.push({ id, capturedAtMs: loaded.ok ? loaded.value.capturedAtMs : 0 });
    }
    dated.sort((a, b) => a.capturedAtMs - b.capturedAtMs);
    for (const { id } of dated.slice(0, dated.length - this.maxBaselines)) {
      await removeFile(this.file(id));
    }
  }
}

/** Look up a control's value in a baseline. */
export function baselineValue(baseline: Baseline, control: ControlId): ControlValue | null {
  return baseline.controlStates.find((s) => s.control === control)?.value ?? null;
}
