# Checkpoints, backups and rollback

Three artifact kinds are kept deliberately distinct. Conflating them is how
systems end up deleting the only copy of something that mattered.

| Kind | Purpose | Lifetime | Location |
|---|---|---|---|
| **Checkpoint** | Short-term pre-change recovery | Bounded count (50), oldest pruned | `checkpoints/` |
| **Backup** | Longer-term deliberate recovery artifact | Kept until removed | `backups/` |
| **Log** | Historical evidence of what happened | Bounded by size and age, never emptied | `events/` |

Baselines (`baselines/`) are a fourth thing again: the record of what the
machine looked like before NEXUS touched anything.

## What a checkpoint records

For every control an operation will touch: the exact prior value, whether it is
restorable, and which adapter read it. A control whose value could not be read
is recorded as **not restorable** rather than omitted — the record shows what
was attempted — and its presence makes the whole checkpoint `partial`.

The engine refuses to proceed on a partial checkpoint. A change it could not
undo is not one it makes on its own initiative.

## Scope

**A restore may only write the controls its checkpoint captured.** The `only`
parameter can narrow that set; it can never extend it. Asking to restore a
control that is not in the checkpoint is an error, not a silent no-op, and the
test suite attacks this directly.

This is what stops a rollback from reaching outside its intended blast radius —
including during crash recovery, where the restore is narrowed further to
exactly the controls the interrupted run had actually written.

## Verification

Every restore writes and then reads back. A restore is `complete` only if every
entry was both restored *and* verified. Anything less is reported as incomplete
with per-control detail, and the caller fails closed.

## What is not claimed

- A control marked `irreversible` or of `unknown` reversibility is never
  auto-applied, so there is no rollback to claim.
- A control that only takes effect after a reboot cannot be measured or
  reverted within a session. It requires explicit confirmation, and NEXUS says
  plainly that it cannot verify the result.
- If NEXUS cannot read a control's current value, it does not pretend it could
  put it back.

## Rollback is a write, and goes through the kernel

Restoring a checkpoint changes the machine, so it passes through the safety
kernel like any other write — `SafetyKernel.evaluateRollback`. It is gated
*differently* from an optimization, on purpose:

- **Refused outright** when the policy is `observationOnly`. That switch means
  "do not write to this machine", and it has no exceptions.
- **Refused for a non-human origin** while NEXUS is observation-only. Vesper
  cannot write on its own say-so in a mode whose whole point is that NEXUS
  changes nothing.
- **Permitted for a human** while NEXUS is degraded, observation-only or
  recovering. Putting a setting back is the safe direction, and it has to stay
  available exactly when NEXUS has stopped trusting itself — refusing would
  strand the machine in a state NEXUS created and cannot undo.
- **Not subject to cooldowns or the hourly rate limit.** Those exist to stop a
  control being churned; refusing a revert because of them would be precisely
  the wrong answer.
- **Refused for any control that is now prohibited or read-only**, even to
  restore a previous value.

A restore also reports its own fidelity — the weakest trust across the adapters
that performed it. A rollback carried out by mock adapters is `mocked`, however
complete it was, and Vesper is told so.

## Using it

```
nexus checkpoints              # list them
nexus rollback ckpt_abc123     # restore one
```

Exit code 4 means the restore was incomplete — read the per-control messages.
