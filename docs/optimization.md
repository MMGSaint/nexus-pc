# Optimization

```
OBSERVE → BASELINE → PROPOSE → VALIDATE → APPLY → MEASURE → KEEP/ROLLBACK
```

## Doing nothing is a result

`NO_ACTION` with a reason is a success, not a failure to find something to do.
The reasons are enumerated (`NoActionReason`) and reported:

| Reason | Meaning |
|---|---|
| `already_optimal` | Every setting already holds its target value |
| `negligible_benefit` | The expected gain does not justify the change |
| `low_confidence` | The workload could not be classified confidently enough to act on |
| `unsafe` | The change could not be made reversible |
| `capability_unavailable` | A required interface is not present |
| `cost_exceeds_benefit` | The change would cost more than it returns |
| `observation_only` | NEXUS is in observation mode |
| `degraded` | NEXUS cannot vouch for the machine's state |
| `cooldown` | This control was changed too recently |
| `no_proposal_generated` | No profile targets this workload |

`nexus optimize` on an idle machine printing "No change is required" is the
system working.

## The pipeline

**Propose.** The difference between a profile's settings and the machine's
current values. If the workload is `unknown`, or its confidence is below the
action floor (60%), no proposal is generated at all.

**Validate.** The safety kernel returns `allow`, `requires-confirmation` or
`reject`, with findings. Rejection is all-or-nothing; a verdict that is not
`allow` returns no permitted changes.

**Journal.** The operation is recorded before anything is touched, and advanced
with `fsync` at every state transition. A journal entry still in the page cache
when the machine loses power is worthless.

**Checkpoint.** Prior values are captured for every control the operation will
touch, *before* the first write. If any could not be read, the operation stops
here and returns `no_action` / `unsafe` — a change that cannot be undone is not
one NEXUS takes on its own.

**Apply.** Each control is written and immediately read back. A write that
reports success but does not change the observable value is a failure: from
NEXUS's point of view nothing happened, and the checkpoint would be misleading.
The journal records which controls were actually written, so a crash mid-loop
is recoverable.

**Measure.** Telemetry moves to high-resolution sampling for a bounded window
(20 s by default), then before/after summaries are compared. A difference
smaller than the metric's noise floor is reported as not significant.

**Keep or roll back.** The default policy keeps a change unless a regression
was measured. It rolls back when:

- a regression was measured — a thermal rise of 8 °C or more is the hard stop;
- the effect could not be measured at all (telemetry produced nothing usable),
  because keeping an unmeasured change is keeping it on faith;
- the run was configured with `--require-benefit` and no benefit appeared.

If the rollback itself cannot be completed and verified, the outcome is
`applied_unverified`, the runtime drops to observation-only, and a `critical`
audit record is written. NEXUS says it does not know rather than reporting a
tidy rollback that did not happen.

## Outcome statuses

| Status | Meaning |
|---|---|
| `no_action` | Nothing needed doing. See `noActionReason`. |
| `rejected` | The safety kernel refused. |
| `requires_confirmation` | A human must explicitly confirm. |
| `applied_kept` | Applied, measured, kept. |
| `applied_rolled_back` | Applied, then reverted and verified. |
| `applied_unverified` | Applied; the state could not be confirmed. Fail closed. |
| `failed` | Could not be carried out; nothing was left changed. |

Every outcome carries the weakest fidelity of the actuators involved. An
outcome produced through mock adapters is `mocked`, whoever asked for it.

## Operating modes

| Mode | Behaviour |
|---|---|
| `observation` | Measures and reports. Changes nothing. **The default.** |
| `assisted` | Accepts explicit optimization requests; never acts on its own. |
| `autonomous` | Also acts on its own proposals, within the policy. |

```
nexus config set-mode assisted
```

A fresh installation observes. Moving beyond that is a deliberate act by the
person who owns the machine, taken after they have seen evidence that NEXUS is
reading their hardware correctly.

## Learning

`toOutcomeReport` produces a structured result an orchestrator can learn from:
what was recommended, what was observed, and whether the result was a benefit,
no measurable benefit, a regression, or unverified.

NEXUS does not modify itself from it. A single observation is not evidence, and
learning must never become safety-policy mutation.
