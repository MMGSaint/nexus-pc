# Crash recovery

## Detecting a crash

The session record is written at startup with `cleanShutdown: false` and set to
`true` only by the orderly shutdown path. If the previous record exists and was
never marked clean, the previous session died. No guessing, no heuristics about
process age.

`previousShutdown` reports `clean`, `crash`, `unknown` or `never_started`, and
appears in the health report.

## Reconciling interrupted operations

The governing rule: **an interrupted operation is never assumed to have
succeeded.**

The operation journal records where each operation had got to *before* each
step, with `fsync`. On startup, every operation left in a non-terminal state is
reconciled:

| Journal state | What it means | Action |
|---|---|---|
| `intent`, `checkpointed` | Nothing was written | Mark abandoned |
| `applying`, `applied`, `measuring` | Writes may have landed | Restore the captured values for exactly the controls that were written |

The restore is narrowed to `appliedControls` — a control the interrupted run
never reached must not be touched by the recovery either.

## When recovery cannot finish

If a restore cannot be completed and verified, or an operation was mid-apply
with no checkpoint at all, recovery reports `unresolved`. NEXUS then:

- writes a `recovery.failed` audit record;
- adds the reason to `degradedReasons`;
- drops to `observation_only`, refusing every write.

Continuing to optimise from a state you cannot describe is how a small problem
becomes a confusing one. NEXUS stops and says so.

```
nexus health     # recoveryRequired, recoverySummary, degradedReasons
nexus audit tail # the recovery.* records
```

To clear it: inspect what the audit trail says was in flight, put the machine
where you want it (`nexus rollback <checkpointId>` if a usable checkpoint
exists), and restart NEXUS.

## Restart loops

See [startup.md](startup.md). Repeated restarts inside a short window bring
NEXUS up in observation-only rather than repeating whatever is failing.

## What survives a crash

| Artifact | Durability |
|---|---|
| Audit log | Append-only; `error`/`critical` records fsynced; chain detects loss |
| Operation journal | Every transition fsynced |
| Checkpoints | Written atomically with fsync |
| Baselines | Written atomically with fsync |
| Session record | Written atomically with fsync at start and end |
| Telemetry history | In memory only — deliberately. It is high-volume and regenerable. |

Every persisted document is written to a temporary file and renamed over the
target, so a crash mid-write leaves either the previous document or the new
one, never a truncated file.
