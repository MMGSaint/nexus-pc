import type { CommandRunner } from '../core/exec.js';
import { nexusError } from '../core/errors.js';
import type { NexusError } from '../core/errors.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

export interface NativeCpuSet {
  readonly id: number;
  readonly group: number;
  readonly logicalProcessorIndex: number;
  readonly coreIndex: number;
  readonly lastLevelCacheIndex: number;
  readonly numaNodeIndex: number;
  readonly efficiencyClass: number;
  readonly parked: boolean;
  readonly allocated: boolean;
  readonly allocatedToTargetProcess: boolean;
  readonly realTime: boolean;
}

export interface ForegroundProcess {
  readonly available: boolean;
  readonly pid: number | null;
  readonly processName: string | null;
}

export interface DefaultCpuSets {
  readonly pid: number;
  readonly ids: readonly number[];
  readonly explicitlyAssigned: boolean;
}

export interface NativeWindowsHelperOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
}

function helperName(options?: NativeWindowsHelperOptions): string {
  return options?.executable ?? 'nexus-native-helper.exe';
}

function parseObject(stdout: string): Result<Record<string, unknown>, NexusError> {
  const line = stdout.replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!line) return err(nexusError('E_UNAVAILABLE', 'native Windows helper produced no output'));
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return err(nexusError('E_IO', 'native Windows helper returned a non-object response'));
    }
    return ok(parsed as Record<string, unknown>);
  } catch (error) {
    return err(nexusError('E_IO', 'native Windows helper returned invalid JSON', undefined, error));
  }
}

async function call(
  runner: CommandRunner,
  request: Record<string, unknown>,
  options?: NativeWindowsHelperOptions,
): Promise<Result<Record<string, unknown>, NexusError>> {
  const result = await runner.run({
    file: helperName(options),
    args: [],
    timeoutMs: options?.timeoutMs ?? 10_000,
    maxOutputBytes: 512 * 1024,
    stdin: JSON.stringify(request) + '\n',
  });
  if (!result.ok) return err(result.error);
  if (result.value.timedOut) return err(nexusError('E_TIMEOUT', 'native Windows helper timed out'));
  if (result.value.code !== 0 && result.value.stdout.trim() === '') {
    return err(nexusError('E_UNAVAILABLE', result.value.stderr.trim() || 'native Windows helper exited unsuccessfully'));
  }
  const parsed = parseObject(result.value.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.value['ok'] !== true) {
    return err(nexusError('E_UNAVAILABLE', String(parsed.value['error'] ?? 'native Windows helper refused the request')));
  }
  const payload = parsed.value['result'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return err(nexusError('E_IO', 'native Windows helper returned an invalid result payload'));
  }
  return ok(payload as Record<string, unknown>);
}

function finiteInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

export async function getSystemCpuSets(
  runner: CommandRunner,
  options?: NativeWindowsHelperOptions,
): Promise<Result<readonly NativeCpuSet[], NexusError>> {
  const result = await call(runner, { command: 'topology' }, options);
  if (!result.ok) return result;
  const raw = result.value;
  if (!Array.isArray(raw)) return err(nexusError('E_IO', 'native topology payload was not an array'));
  const sets: NativeCpuSet[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const x = item as Record<string, unknown>;
    const id = finiteInt(x.id);
    const group = finiteInt(x.group);
    const logicalProcessorIndex = finiteInt(x.logicalProcessorIndex);
    const coreIndex = finiteInt(x.coreIndex);
    const lastLevelCacheIndex = finiteInt(x.lastLevelCacheIndex);
    const numaNodeIndex = finiteInt(x.numaNodeIndex);
    const efficiencyClass = finiteInt(x.efficiencyClass);
    if (
      id === null ||
      group === null ||
      logicalProcessorIndex === null ||
      coreIndex === null ||
      lastLevelCacheIndex === null ||
      numaNodeIndex === null ||
      efficiencyClass === null
    ) continue;
    sets.push({
      id, group, logicalProcessorIndex, coreIndex, lastLevelCacheIndex,
      numaNodeIndex, efficiencyClass,
      parked: bool(x.parked),
      allocated: bool(x.allocated),
      allocatedToTargetProcess: bool(x.allocatedToTargetProcess),
      realTime: bool(x.realTime),
    });
  }
  return ok(sets);
}

export async function getForegroundProcess(
  runner: CommandRunner,
  options?: NativeWindowsHelperOptions,
): Promise<Result<ForegroundProcess, NexusError>> {
  const result = await call(runner, { command: 'foreground' }, options);
  if (!result.ok) return result;
  return ok({
    available: result.value['available'] === true,
    pid: finiteInt(result.value['pid']),
    processName: typeof result.value['processName'] === 'string' ? result.value['processName'] : null,
  });
}

export async function getProcessDefaultCpuSets(
  runner: CommandRunner,
  pid: number,
  options?: NativeWindowsHelperOptions,
): Promise<Result<DefaultCpuSets, NexusError>> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return err(nexusError('E_INVALID_INPUT', 'pid must be a positive integer'));
  const result = await call(runner, { command: 'get-default-cpu-sets', pid }, options);
  if (!result.ok) return result;
  const ids = Array.isArray(result.value['ids'])
    ? result.value['ids'].filter((x): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0).sort((a,b)=>a-b)
    : [];
  return ok({ pid, ids, explicitlyAssigned: result.value['explicitlyAssigned'] === true });
}

export async function setProcessDefaultCpuSets(
  runner: CommandRunner,
  pid: number,
  ids: readonly number[],
  options?: NativeWindowsHelperOptions,
): Promise<Result<DefaultCpuSets, NexusError>> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return err(nexusError('E_INVALID_INPUT', 'pid must be a positive integer'));
  if (ids.length > 256 || ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    return err(nexusError('E_INVALID_INPUT', 'CPU Set IDs must be positive integers and the list may contain at most 256 IDs'));
  }
  const unique = [...new Set(ids)].sort((a,b)=>a-b);
  const result = await call(runner, { command: 'set-default-cpu-sets', pid, cpuSetIds: unique }, options);
  if (!result.ok) return result;
  const observed = await getProcessDefaultCpuSets(runner, pid, options);
  if (!observed.ok) return observed;
  if (observed.value.ids.length !== unique.length || observed.value.ids.some((id, i) => id !== unique[i])) {
    return err(nexusError('E_VERIFY_FAILED', 'Windows did not verify the requested process CPU-set assignment', { pid, requested: unique, observed: observed.value.ids }));
  }
  return observed;
}

/** Group CPU Sets by LLC/cache domain for topology-aware scheduling experiments. */
export function groupCpuSetsByCache(sets: readonly NativeCpuSet[]): Map<number, NativeCpuSet[]> {
  const groups = new Map<number, NativeCpuSet[]>();
  for (const set of sets) {
    const current = groups.get(set.lastLevelCacheIndex) ?? [];
    current.push(set);
    groups.set(set.lastLevelCacheIndex, current);
  }
  return groups;
}

/** Never use allocated, parked, or real-time CPU Sets as ordinary application targets without explicit policy. */
export function safeCpuSets(sets: readonly NativeCpuSet[]): NativeCpuSet[] {
  return sets.filter((set) => !set.allocated && !set.parked && !set.realTime);
}
