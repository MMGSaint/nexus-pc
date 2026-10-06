/**
 * PresentMon capture adapter.
 *
 * BORROWED-INTEGRATION: use Intel/GameTechDev PresentMon as the mature ETW
 * collector. NEXUS does not reproduce ETW present tracking.
 *
 * Upstream supports targeting by process id/name, timed captures, CSV output,
 * v1/v2 metrics and GPU/display tracking. See docs/third-party.md.
 */

import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { CommandRunner } from '../core/exec.js';
import { nexusError, type NexusError } from '../core/errors.js';
import { err, ok } from '../core/result.js';
import type { Result } from '../core/result.js';
import type { NexusPaths } from '../core/paths.js';
import { ensureDir } from '../core/fsx.js';
import {
  summarizeFrames,
  type FramePerformanceSummary,
  type FrameSample,
  type FrameType,
} from './stats.js';

export interface PresentMonCaptureRequest {
  readonly processId?: number;
  readonly processName?: string;
  readonly seconds: number;
  readonly outputFile?: string;
}

export interface PresentMonCaptureResult {
  readonly processId?: number;
  readonly processName?: string;
  readonly summary: FramePerformanceSummary;
  readonly csvPath: string;
  readonly stdout: string;
  readonly stderr: string;
}

const ALLOWED_SECONDS_MIN = 1;
const ALLOWED_SECONDS_MAX = 900;

function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function parseFrameType(value: string | undefined): FrameType | undefined {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'application' || normalized === 'app') return 'application';
  if (normalized === 'repeated' || normalized === 'repeat') return 'repeated';
  if (normalized.includes('amd') && normalized.includes('afmf')) return 'amd_afmf';
  if (normalized.includes('xefg') || normalized.includes('intel')) return 'intel_xefg';
  return 'unknown';
}

function parseBoolDropped(fields: Record<string, string>): boolean | undefined {
  const candidate = fields.Dropped ?? fields.dropped ?? fields.FinalState ?? fields.finalState ?? fields.PresentResult;
  if (candidate === undefined) return undefined;
  const normalized = candidate.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'dropped' || normalized === 'discarded') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'presented' || normalized === 'displayed') return false;
  return undefined;
}

export function parsePresentMonCsv(csv: string): FrameSample[] {
  const lines = csv.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const headers = csvFields(lines[0]!).map((h) => h.replace(/^\uFEFF/, '').trim());
  const samples: FrameSample[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = csvFields(lines[i]!);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j += 1) row[headers[j]!] = values[j] ?? '';

    const frameTime = parseNumber(row.FrameTime) ?? parseNumber(row.MsBetweenPresents);
    if (frameTime === null || frameTime <= 0 || frameTime > 10_000) continue;

    const gpuTimeMs = parseNumber(row.GPUTime) ?? parseNumber(row.msGPUActive);
    const cpuBusyMs = parseNumber(row.CPUBusy) ?? parseNumber(row.msCPUBusy);
    const displayLatencyMs =
      parseNumber(row.MsUntilDisplayed) ??
      parseNumber(row.DisplayLatency) ??
      parseNumber(row.msUntilDisplayed);
    const presentIntervalMs =
      parseNumber(row.MsBetweenPresents) ??
      parseNumber(row.BetweenPresents);
    const displayIntervalMs =
      parseNumber(row.MsBetweenDisplayChange) ??
      parseNumber(row.BetweenDisplayChange);
    const dropped = parseBoolDropped(row);
    const frameType = parseFrameType(row.FrameType);

    samples.push({
      frameTimeMs: frameTime,
      ...(gpuTimeMs === null ? {} : { gpuTimeMs }),
      ...(cpuBusyMs === null ? {} : { cpuBusyMs }),
      ...(displayLatencyMs === null ? {} : { displayLatencyMs }),
      ...(presentIntervalMs === null ? {} : { presentIntervalMs }),
      ...(displayIntervalMs === null ? {} : { displayIntervalMs }),
      ...(frameType === undefined ? {} : { frameType }),
      ...(dropped === undefined ? {} : { dropped }),
    });
  }
  return samples;
}

export class PresentMonCollector {
  private readonly runner: CommandRunner;
  private readonly paths: NexusPaths;
  private sequence = 0;

  constructor(input: { runner: CommandRunner; paths: NexusPaths }) {
    this.runner = input.runner;
    this.paths = input.paths;
  }

  async capture(input: PresentMonCaptureRequest): Promise<Result<PresentMonCaptureResult, NexusError>> {
    const seconds = Math.max(ALLOWED_SECONDS_MIN, Math.min(ALLOWED_SECONDS_MAX, Math.round(input.seconds)));
    if (input.processId === undefined && !input.processName) {
      return err(nexusError('E_INVALID_INPUT', 'PresentMon capture requires a target process id or executable name.'));
    }
    if (input.processId !== undefined && (!Number.isInteger(input.processId) || input.processId <= 0)) {
      return err(nexusError('E_INVALID_INPUT', 'PresentMon processId must be a positive integer.'));
    }
    if (input.processName && !/^[A-Za-z0-9_. -]{1,128}$/.test(input.processName)) {
      return err(nexusError('E_INVALID_INPUT', 'PresentMon processName contains unsupported characters.'));
    }

    await ensureDir(this.paths.runtime);
    const csvPath = input.outputFile
      ? path.resolve(input.outputFile)
      : path.join(this.paths.runtime, `presentmon-${this.sequence++}.csv`);

    // For safety, default output stays under NEXUS runtime. A caller-supplied
    // file must still be an absolute path and must remain outside no trust boundary
    // other than the caller's own account; PresentMon only writes the evidence file.
    const session = `nexus-${this.sequence++}`;
    const args = [
      '--stop_existing_session',
      '--terminate_after_timed',
      '--timed', String(seconds),
      '--session_name', session,
      '--no_console_stats',
      '--v2_metrics',
      '--track_frame_type',
      '--track_app_timing',
      '--output_file', csvPath,
      ...(input.processId === undefined ? ['--process_name', input.processName!] : ['--process_id', String(input.processId)]),
    ];

    const started = await this.runner.run({
      file: 'PresentMon.exe',
      args,
      timeoutMs: (seconds + 15) * 1000,
      maxOutputBytes: 256 * 1024,
    });
    if (!started.ok) return started;

    try {
      if (started.value.code !== 0) {
        return err(nexusError('E_IO', `PresentMon exited with code ${started.value.code ?? 'unknown'}: ${started.value.stderr.trim() || 'no error text'}`));
      }
      let csv: string;
      try {
        csv = await readFile(csvPath, 'utf8');
      } catch (error) {
        return err(nexusError('E_UNAVAILABLE', `PresentMon completed but no CSV was found at ${csvPath}: ${error instanceof Error ? error.message : String(error)}`));
      }
      const samples = parsePresentMonCsv(csv);
      return ok({
        ...(input.processId === undefined ? {} : { processId: input.processId }),
        ...(input.processName === undefined ? {} : { processName: input.processName }),
        summary: summarizeFrames(samples),
        csvPath,
        stdout: started.value.stdout,
        stderr: started.value.stderr,
      });
    } finally {
      // Evidence CSVs can be large. Callers that want durable evidence should
      // copy/archive them explicitly; normal telemetry should not fill NEXUS's
      // runtime directory forever.
      await unlink(csvPath).catch(() => undefined);
    }
  }
}
