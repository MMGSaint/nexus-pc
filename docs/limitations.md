# Known limitations

Read [implementation-status.md](implementation-status.md) first for what is
tested versus hardware dependent versus absent. This page covers the design
tradeoffs and rough edges that are not simply "not built yet".

## Nothing has run on the target machine

Everything was developed and tested on Linux. The Windows provider, the Windows
telemetry source, the persistent PowerShell host and the `powercfg` adapters
have never executed against real Windows. They are written, typechecked and
unit tested against scripted inputs — which catches parsing bugs, not
assumptions about what Windows actually returns.

Each is behind a capability probe, so a wrong assumption shows up as an
unavailable capability rather than a wrong action. That is the mitigation, not
a claim that it works.

## No temperature means no thermal-gated optimization

Without a sensor bridge, `power.processor.boost_mode`, `min_state` and
`max_state` are refused with `THERMAL_UNVERIFIABLE`. On a stock machine NEXUS
can therefore read a great deal and change comparatively little.

This is intended. The alternative — adjusting a boost mode on a machine whose
temperature you cannot read — is exactly the behaviour this system is built to
avoid. But it does mean the out-of-the-box value on a stock Windows install is
mostly observation until a bridge exists.

## Power-plan edits touch the user's active scheme

NEXUS modifies the **active** power scheme and checkpoints the exact prior
index of every setting it changes. That is fully reversible and verified.

The safer design duplicates the user's scheme with `powercfg /duplicatescheme`
and edits only the copy, so the user's own plan is never touched at all. That
is the planned next step and is not implemented here — it adds state and
parsing that could not be validated on Windows in this environment. Until then,
if you have a hand-tuned power plan, note that NEXUS edits it in place (and can
put it back).

## Workload classification runs blind to processes

Process enumeration is not implemented, so classification works from
utilisation and memory alone. It says so — `process.enumerate` appears in
`missingSignals` and confidence is capped accordingly.

The practical effect: NEXUS can tell a GPU-bound workload from an idle one, but
it cannot tell Squad from Where Winds Meet, and it cannot detect that OBS is
encoding. The process-hint table exists and is tested, but has no live source
feeding it. This is the single biggest gap for the user's actual workloads, and
it is where Vesper's context hints are most valuable in the meantime.

Even with processes, name matching is a heuristic: a renamed executable defeats
it and an unknown game is invisible to it. The classifier labels those reasons
as heuristics rather than presenting them as facts.

## Measurement is coarse

Before/after comparison uses mean values over short windows with conservative
noise floors. It can detect a thermal regression or a large utilisation shift.
It **cannot** measure frame times, 1% lows, frame pacing, input latency or
stutter — the things that actually matter for the user's gaming workloads.

So "no measurable benefit" from NEXUS means *NEXUS could not measure a benefit*,
not that none exists. The wording in the outcome summary is deliberate.

## Simulation cannot exercise the apply path end to end

Because simulated signals cap classification confidence below the action floor,
and sensitive controls require `live` telemetry, a `--simulate` run can never
apply a change. That is a genuine safety property — a simulation cannot talk
NEXUS into modifying a real machine — but it means the CLI apply path is
covered by unit tests with constructed live-fidelity telemetry rather than by
end-to-end simulation.

## Single machine, single user

No multi-machine coordination, no roaming profiles, no telemetry aggregation
across machines. The baseline is tied to a hashed machine identity and does not
transfer.

## No GUI

CLI and background process only. No tray icon, no window. The Windows residency
design (a logon task rather than a service) leaves room for one, but it is not
built.

## The audit log detects tampering, it does not prevent it

The hash chain makes an edit or deletion visible. Someone with write access to
the directory can still delete the file. This is detection, not prevention, and
there is no external anchor.

## Retention is bounded, which means history is lost

Audit segments, checkpoints, baselines and journal records are all pruned. The
bounds are conservative and the newest artifact is never removed, but a
long-running installation will not retain everything forever. If you need a
particular baseline or audit segment kept, copy it out.

## Rollback remains available to a human when NEXUS is degraded

By design: a revert is the corrective action, and refusing it while NEXUS is
observation-only would leave the machine in a state NEXUS created and could not
undo. The consequence is that "observation-only" is not literally "no writes
ever" — a human can still ask for a restore. The `observationOnly` *policy*
switch is the absolute one, and it refuses everything including rollbacks.

## Restart guard is per-home, not per-machine

The restart counter lives in the NEXUS home. Two homes on one machine have
independent guards. Not a problem in normal use; worth knowing if you script
around it.

## `os.cpus()` limits on very large machines

Node's `os.cpus()` is capped at 64 logical processors on Windows. Irrelevant
for a 32-thread 9950X, but no topology feature should be built on it.

## WMI cannot see CCD boundaries

The 9950X is two CCDs of 8 cores with separate L3 per CCD, which matters for
scheduling and for interpreting per-CCD temperatures. `Win32_Processor` reports
one socket with 16 cores and no hint of the split. NEXUS does not currently
expose CCD topology.
