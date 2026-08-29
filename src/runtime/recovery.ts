/**
 * Crash recovery.
 *
 * The governing rule: an interrupted operation is never assumed to have
 * succeeded. On startup, every operation the journal left in a non-terminal
 * state is reconciled:
 *
 *   intent / checkpointed   nothing was written. Mark abandoned; done.
 *   applying / applied /    writes may have landed. Restore the captured
 *   measuring               values for exactly the controls that were written.
 *
 * If a restore cannot be completed and verified, NEXUS does not shrug and
 * carry on. It reports that the machine's state is unverified and the runtime
 * drops to observation-only, because continuing to optimise from a state you
 * cannot describe is how small problems become confusing ones.
 */

import type { Logger } from '../core/logger.js';
import type { EventLog } from '../audit/eventlog.js';
import type { CheckpointStore } from '../checkpoint/store.js';
import type { ActuatorContext } from '../optimizer/actuator.js';
import type { OperationJournal, OperationRecord } from '../optimizer/journal.js';
import { IN_FLIGHT_MUTATING } from '../optimizer/journal.js';

export interface RecoveryAction {
  readonly operationId: string;
  readonly previousStatus: string;
  readonly action: 'abandoned' | 'rolled_back' | 'rollback_failed' | 'no_checkpoint';
  readonly detail: string;
}

export interface RecoveryOutcome {
  readonly required: boolean;
  readonly actions: readonly RecoveryAction[];
  /** True when at least one control could not be returned to a known state. */
  readonly unresolved: boolean;
  readonly summary: string;
}

export interface RecoveryOptions {
  readonly journal: OperationJournal;
  readonly checkpoints: CheckpointStore;
  readonly eventLog: Pick<EventLog, 'append'>;
  readonly logger: Logger;
  readonly context: ActuatorContext;
}

export async function recoverInterruptedOperations(options: RecoveryOptions): Promise<RecoveryOutcome> {
  const unfinished = await options.journal.unfinished();
  if (unfinished.length === 0) {
    return {
      required: false,
      actions: [],
      unresolved: false,
      summary: 'No interrupted operations were found.',
    };
  }

  await options.eventLog.append({
    kind: 'recovery.started',
    severity: 'warning',
    message: `Reconciling ${unfinished.length} operation(s) left unfinished by a previous session`,
    data: { operations: unfinished.map((o) => `${o.id}:${o.status}`) },
  });

  const actions: RecoveryAction[] = [];
  for (const record of unfinished) {
    actions.push(await reconcile(record, options));
  }

  const unresolved = actions.some((a) => a.action === 'rollback_failed' || a.action === 'no_checkpoint');

  await options.eventLog.append({
    kind: unresolved ? 'recovery.failed' : 'recovery.completed',
    severity: unresolved ? 'error' : 'notice',
    message: unresolved
      ? 'Recovery could not return every control to a known state'
      : 'Recovery completed; all interrupted operations reconciled',
    data: { actions: actions.map((a) => `${a.operationId}:${a.action}`) },
  });

  return {
    required: true,
    actions,
    unresolved,
    summary: unresolved
      ? `Reconciled ${actions.length} interrupted operation(s), but at least one control could not be returned to a known state. NEXUS is running in observation-only mode until a human confirms the machine's state.`
      : `Reconciled ${actions.length} interrupted operation(s); the machine has been returned to its captured state.`,
  };
}

async function reconcile(record: OperationRecord, options: RecoveryOptions): Promise<RecoveryAction> {
  const wasMutating = IN_FLIGHT_MUTATING.has(record.status);

  if (!wasMutating) {
    await options.journal.advance(record, 'abandoned', 'interrupted before any write was issued');
    return {
      operationId: record.id,
      previousStatus: record.status,
      action: 'abandoned',
      detail: 'The operation was interrupted before anything was changed.',
    };
  }

  if (record.checkpointId === null) {
    await options.journal.advance(
      record,
      'failed',
      'interrupted after writing, with no checkpoint to restore from',
    );
    return {
      operationId: record.id,
      previousStatus: record.status,
      action: 'no_checkpoint',
      detail:
        'The operation had begun writing but no checkpoint was recorded, so the previous values are unknown.',
    };
  }

  // The engine journals each control before it writes it, so an empty set is
  // authoritative: no write was issued and there is nothing to put back.
  // Widening to the whole checkpoint here — as this previously did — would let
  // recovery revert controls the interrupted run never reached, including a
  // change the user made by hand between the crash and the restart.
  if (record.appliedControls.length === 0) {
    await options.journal.advance(record, 'abandoned', 'interrupted before any write was issued');
    return {
      operationId: record.id,
      previousStatus: record.status,
      action: 'abandoned',
      detail: 'The operation was interrupted before any write was issued.',
    };
  }

  // Restore exactly what was written — not the whole checkpoint.
  const restored = await options.checkpoints.restore(
    record.checkpointId,
    options.context,
    record.appliedControls,
  );

  if (!restored.ok || !restored.value.complete) {
    const detail = restored.ok
      ? restored.value.entries
          .filter((e) => !e.restored || !e.verified)
          .map((e) => `${e.control}: ${e.message}`)
          .join('; ')
      : restored.error.message;
    await options.journal.advance(record, 'failed', `recovery rollback incomplete: ${detail}`);
    options.logger.error('recovery could not restore an interrupted operation', {
      operation: record.id,
      detail,
    });
    return {
      operationId: record.id,
      previousStatus: record.status,
      action: 'rollback_failed',
      detail: `Could not restore the captured state: ${detail}`,
    };
  }

  await options.journal.advance(record, 'rolled_back', 'restored by crash recovery');
  await options.eventLog.append({
    kind: 'checkpoint.restored',
    severity: 'notice',
    message: `Restored ${restored.value.entries.length} control(s) after an interrupted operation`,
    correlationId: record.id,
    data: { checkpointId: record.checkpointId },
  });
  return {
    operationId: record.id,
    previousStatus: record.status,
    action: 'rolled_back',
    detail: `Restored ${restored.value.entries.length} control(s) to their captured values.`,
  };
}
