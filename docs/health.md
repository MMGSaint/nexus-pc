# Health

"The process exists" is not health. `nexus health` answers, at any moment
including during startup:

| Question | Field |
|---|---|
| Is NEXUS running, and in what state? | `runState`, `stages` |
| Is hardware detected, and how real is it? | `hardwareDetected`, `hardwareFidelity` |
| Is telemetry working? | `telemetryWorking`, `telemetryFidelity` |
| Which capabilities are available? | `capabilities.available` |
| Which are not, and why? | `capabilities.unavailable`, and `nexus doctor` for reasons |
| What profile is active? | `activeProfileId` |
| Is optimization enabled? | `optimizationEnabled`, `optimizationDisabledReason` |
| Is NEXUS degraded? | `degraded`, `degradedReasons` |
| Did the previous session end cleanly? | `previousShutdown` |
| Is recovery required? | `recoveryRequired`, `recoverySummary` |
| Is Vesper available? | `vesperInterface` |
| What is NEXUS costing? | `selfFootprint` |

## Run states

| State | Meaning |
|---|---|
| `initializing` | Started; stages still coming up. Not a claim of readiness. |
| `ready` | All required stages complete; optimization permitted. |
| `degraded` | Running, but something non-critical failed. |
| `observation_only` | Running with writes disabled. Reporting continues. |
| `recovering` | Reconciling an unclean previous session. |
| `stopping` / `stopped` | Shutting down / down. |
| `failed` | Could not start. |

## Commands

```
nexus health            # the report
nexus health --json     # for machines
nexus doctor            # health + hardware + capabilities + telemetry +
                        # workload + audit + an explicit list of what NEXUS
                        # cannot do on this machine and why
```

`nexus doctor` exits non-zero when NEXUS is degraded, which makes it usable as
a check in a scheduled task.

## Self footprint

NEXUS reports its own RSS, its CPU as a percentage of one core, its current
sampling mode and interval. If it exceeds its CPU budget it lengthens its own
sampling interval and logs the fact. CPU is only estimated over intervals of at
least 2 seconds — below that the figure would be scheduler noise.
