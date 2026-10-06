import type { CommandRunner } from '../core/exec.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { nexusError, type NexusError } from '../core/errors.js';
import {
  getProcessDefaultCpuSets,
  getSystemCpuSets,
  setProcessDefaultCpuSets,
  safeCpuSets,
  type DefaultCpuSets,
} from './windows-native.js';

export interface ProcessPlacementPlan {
  readonly pid: number;
  readonly before: readonly number[];
  readonly target: readonly number[];
  readonly cacheDomain: number;
  readonly createdAtMs: number;
  readonly rationale: string;
}

export interface PlacementResult {
  readonly plan: ProcessPlacementPlan;
  readonly observed: DefaultCpuSets;
  readonly verified: boolean;
}

export class WindowsProcessPlacementController {
  constructor(
    private readonly runner: CommandRunner,
    private readonly helperOptions?: NativeWindowsHelperOptions,
  ) {}

  async planForCacheDomain(
    pid: number,
    cacheDomain: number,
    options: { includeParked?: boolean; requireAllUnallocated?: boolean } = {},
  ): Promise<Result<ProcessPlacementPlan, NexusError>> {
    const before = await getProcessDefaultCpuSets(this.runner, pid, this.helperOptions);
    if (!before.ok) return before;

    const topology = await getSystemCpuSets(this.runner, this.helperOptions);
    if (!topology.ok) return topology;

    const candidates = (options.includeParked ? topology.value : safeCpuSets(topology.value))
      .filter((set) => set.lastLevelCacheIndex === cacheDomain)
      .filter((set) => options.requireAllUnallocated === false || !set.allocated)
      .filter((set) => !set.realTime);

    const unique = [...new Set(candidates.map((set) => set.id))].sort((a, b) => a - b);
    if (unique.length === 0) {
      return err(nexusError(
        'E_UNAVAILABLE',
        'no safe CPU Sets were found in the requested cache domain',
        { pid, cacheDomain },
      ));
    }

    return ok({
      pid,
      before: [...before.value.ids],
      target: unique,
      cacheDomain,
      createdAtMs: Date.now(),
      rationale: `Prefer the observed CPU-set cache domain ${cacheDomain}; target selection is topology-derived and not hardcoded to logical-processor indices.`,
    });
  }

  async apply(plan: ProcessPlacementPlan): Promise<Result<PlacementResult, NexusError>> {
    const observedBefore = await getProcessDefaultCpuSets(this.runner, plan.pid, this.helperOptions);
    if (!observedBefore.ok) return observedBefore;

    // Drift check: do not clobber a user/application assignment that changed
    // since the plan was created.
    if (
      observedBefore.value.ids.length !== plan.before.length ||
      observedBefore.value.ids.some((id, index) => id !== plan.before[index])
    ) {
      return err(nexusError(
        'E_CONFLICT',
        'process CPU-set state changed after the placement plan was created; refusing to overwrite the newer assignment',
        { pid: plan.pid },
      ));
    }

    const applied = await setProcessDefaultCpuSets(this.runner, plan.pid, plan.target, this.helperOptions);
    if (!applied.ok) return applied;

    return ok({
      plan,
      observed: applied.value,
      verified: true,
    });
  }

  async rollback(plan: ProcessPlacementPlan): Promise<Result<DefaultCpuSets, NexusError>> {
    return setProcessDefaultCpuSets(this.runner, plan.pid, plan.before, this.helperOptions);
  }
}
