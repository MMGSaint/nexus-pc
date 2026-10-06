export type StagedApplyTiming = 'next-login' | 'next-launch' | 'manual';

export interface StagedChange {
  readonly id: string;
  readonly gameId: string;
  readonly changes: readonly { key: string; value: string | number | boolean | null }[];
  readonly timing: StagedApplyTiming;
  readonly reason: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number | null;
}

export interface StagedCheckpoint {
  readonly id: string;
  readonly stagedChangeId: string;
  readonly capturedAtMs: number;
  readonly originalState: Readonly<Record<string, string | number | boolean | null>>;
  readonly targetState: Readonly<Record<string, string | number | boolean | null>>;
  readonly reversible: boolean;
}

export function dueStagedChanges(changes: readonly StagedChange[], nowMs: number, context: 'login' | 'launch' | 'manual'): readonly StagedChange[] {
  return changes.filter((item) => {
    if (item.expiresAtMs !== null && nowMs >= item.expiresAtMs) return false;
    if (item.timing === 'manual') return context === 'manual';
    if (item.timing === 'next-login') return context === 'login' || context === 'manual';
    return context === 'launch' || context === 'manual';
  });
}

export function expireStagedChanges(changes: readonly StagedChange[], nowMs: number): readonly StagedChange[] {
  return changes.filter((item) => item.expiresAtMs === null || nowMs < item.expiresAtMs);
}

export function checkpointStagedChange(
  staged: StagedChange,
  originalState: Readonly<Record<string, string | number | boolean | null>>,
  checkpointId: string,
  capturedAtMs: number,
): StagedCheckpoint {
  const targetState: Record<string, string | number | boolean | null> = {};
  for (const change of staged.changes) targetState[change.key] = change.value;
  return { id: checkpointId, stagedChangeId: staged.id, capturedAtMs, originalState: { ...originalState }, targetState, reversible: staged.changes.every((change) => Object.prototype.hasOwnProperty.call(originalState, change.key)) };
}

export function rollbackStagedChange(checkpoint: StagedCheckpoint): Readonly<Record<string, string | number | boolean | null>> | null {
  if (!checkpoint.reversible) return null;
  return { ...checkpoint.originalState };
}