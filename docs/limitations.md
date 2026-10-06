# Known limitations

Read [implementation-status.md](implementation-status.md) first for what is
tested versus hardware dependent versus absent. This page covers the design
tradeoffs and rough edges that are not simply "not built yet".

## Nothing has run on the target machine

Everything was developed and tested on Linux. The Windows provider, Windows telemetry source,
persistent PowerShell host, power adapters, LibreHardwareMonitor bridge, PresentMon capture,
OpenXR probe, driver identity probe, and process/foreground probes have not yet been exercised
on the target Windows machine. They are written, typechecked and
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

## Power-plan edits and sandboxing

The normal power adapters still target the active scheme and checkpoint the exact prior
index of every setting they change. The merged stack also includes an explicit
`powercfg /duplicatescheme` transaction sandbox that can duplicate, activate, verify,
restore, and delete an isolated plan. It is opt-in (`sandboxPowerPlan`) because the
remaining Windows behaviour is still target-PC dependent; the normal checkpoint and
rollback machinery remains authoritative.

## Process evidence is optional and heuristic

Process enumeration is implemented: Linux via `/proc`, Windows via allowlisted
`tasklist` (hardware-dependent until verified on the target machine). When the
capability probe fails, classification still runs from utilisation and memory
alone and lists `process.enumerate` in `missingSignals`, capping confidence.

When enumeration succeeds, process names corroborate classification the same
way a Vesper context hint does — they can raise a candidate's score, never
override telemetry, and never invent a workload on their own. Name matching
remains a heuristic: a renamed executable defeats it and an unknown game is
invisible to it. The classifier labels those reasons as heuristics rather than
presenting them as facts.

Foreground detection is still absent (`isForeground` is always null), so NEXUS
cannot yet prefer the focused window over a background game.

## AMD driver and per-game profile ownership

NEXUS intentionally does not modify AMD Adrenalin's per-game profiles or driver
settings. The NEXUS application-profile feature only selects among explicit NEXUS
profiles from observed process-name heuristics. A driver update or vendor-side
preset change can alter game behaviour without any NEXUS setting changing. NEXUS now stamps the
observed display-driver version into baselines and invalidates an older baseline when a live
driver change is detected, so pre/post-driver measurements are kept separate.

## Measurement has boundaries

NEXUS now has first-class PresentMon frame evidence: displayed/presented/application FPS,
frame-type awareness, frame-time percentiles, generated-frame fraction, AFMF observations,
and display-latency evidence. Benefit decisions can reject changes that improve headline FPS
while worsening dropped frames or display latency.

It still does not measure end-to-end input latency or prove every compositor/driver interaction.
PresentMon remains an external evidence source, and its accuracy depends on the Windows graphics
path and installed version. "No measurable benefit" still means NEXUS could not establish a
benefit with the evidence available, not that none exists.

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
for a 32-thread 9950X3D, but no topology feature should be built on it.

## WMI cannot see CCD boundaries

The 9950X3D uses an X3D-specific multi-CCD topology whose cache and scheduling behaviour matters for
scheduling and for interpreting per-CCD temperatures. `Win32_Processor` reports
one socket with 16 cores and no hint of the split. NEXUS does not currently
expose CCD topology.

## Private target bias

This repository is intentionally biased toward one target machine while it is private. That is deliberate: optimization experiments can be deeper when the hardware, games and workloads are known. The boundary is that machine-specific strategy may narrow automatic behaviour, but it cannot widen the safety kernel or bypass capability, telemetry, baseline, confirmation, or rollback checks.
