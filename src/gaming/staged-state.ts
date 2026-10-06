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

export function dueStagedChanges(
  changes: readonly StagedChange[],
  nowMs: number,
  context: 'login' | 'launch' | 'manual',
): readonly StagedChange[] {
  return changes.filter((item) => {
    if (item.expiresAtMs !== null && nowMs >= item.expiresAtMs) return false;
    if (item.timing === 'manual') return context === 'manual';
    if (item.timing === 'next-login') return context === 'login' || context === 'manual';
    return context === 'launch' || context === 'manual';
  });
}

export function expireStagedChanges(
  changes: readonly StagedChange[],
  nowMs: number,
): readonly StagedChange[] {
  return changes.filter((item) => item.expiresAtMs === null || nowMs < item.expiresAtMs);
}
