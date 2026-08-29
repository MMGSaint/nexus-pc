# Implementation status

Every capability in NEXUS falls into one of four categories. This page is the
authoritative list. It exists because the difference between "we wrote an
adapter" and "this works on your machine" is the difference between a useful
tool and a confident liar.

**Nothing in this repository has been executed against the target Windows
machine.** Development and testing happened on Linux. Anything marked
*hardware dependent* is written, typechecked and unit tested, but its
interaction with real Windows and real AMD hardware is unverified.

---

## IMPLEMENTED + TESTED

Exercised by the automated suite and verified to behave as described.

| Area | What is verified |
|---|---|
| Safety kernel | Deterministic verdicts; prohibited controls refused under every origin; value/range/enum enforcement; capability gating; thermal fail-closed; confirmation origin checks; cooldown and rate limits; authority-claim rejection |
| Policy narrowing | Config can shrink ranges, add requirements, lower thermal ceilings, enable observation-only — and cannot widen, re-allow, shorten a cooldown, or switch a requirement off |
| Capability registry | Unverified until probed; probe failure and timeout become `unavailable`; provider trust clamps reported fidelity |
| Fidelity lattice | Combination never produces a value stronger than its weakest input; only `live` justifies a hardware change |
| Telemetry model | `unknown` is never zero; plausibility bounds reject implausible values; staleness detection; cross-validation of used-vs-total |
| Adaptive sampling | Mode transitions with hysteresis and dwell; bounded optimization window; self-CPU budget back-off; bounded history |
| Checkpoint / rollback | Prior values captured before any write; restore limited to captured controls; scope violations refused; unverifiable restore reported as incomplete; bounded retention |
| Optimization engine | Full pipeline including no-action reasons, apply verification, measurement, keep/rollback, and `applied_unverified` when a rollback cannot be confirmed |
| Operation journal | State transitions persisted with fsync; interrupted operations detected |
| Crash recovery | Pre-write operations abandoned; mid-apply operations rolled back; unresolvable state reported and NEXUS drops to observation-only |
| Audit log | Hash chain across records and segments; edit and deletion detected; concurrent appends serialised; secrets redacted from both data and message; bounded pruning that never empties the log |
| Single instance | OS-level lock via named pipe / unix socket; stale socket reclaimed; holder identified in the refusal |
| Session state | Clean vs unclean shutdown detection; restart-loop guard with a rolling window |
| Staged startup | Health answerable during initialization; failures degrade rather than stop; required stages gate readiness |
| Graceful shutdown | Ordered, bounded, idempotent; session marked clean; background init awaited |
| Profiles | Built-in profiles validate against the policy; user profiles rejected for unknown fields, prohibited controls, out-of-policy values |
| Workload classification | Confidence floors; missing signals cap confidence; `unknown` is a normal answer; context hints corroborate but never override; conflicts reported |
| Vesper interface | Path-based transport only; token auth; scope enforcement with mutating scopes ungranted by default; strict payload validation; depth/size/rate bounds; fidelity on every response |
| Process execution | Executable allowlist; no shell; dynamic values passed via environment, never interpolated into script text; NUL rejection |
| Windows discovery parsing | `qwMemorySize` preferred over `AdapterRAM`; saturated `AdapterRAM` rejected; powercfg output parsing; DDR5 detection; EXPO-not-applied warning |

## IMPLEMENTED + HARDWARE DEPENDENT

Written and typechecked, but never executed against real Windows or AMD
hardware. Each is behind a capability probe, so a wrong assumption shows up as
an unavailable capability rather than an incorrect action.

| Component | What is unverified | Failure mode if wrong |
|---|---|---|
| `WindowsHardwareProvider` | The PowerShell discovery script against a real CIM provider | Discovery fails; NEXUS degrades and reports no inventory |
| `WindowsTelemetrySource` | CIM class and property names for the processor and GPU performance counters | Those metrics report `unavailable`; dependent capabilities are unavailable |
| `PersistentShell` | The long-lived PowerShell host protocol on Windows | Sensor host fails to start; telemetry source degrades |
| `WindowsPowerSchemeAdapter` | `powercfg /getactivescheme` and `/setactive` | The capability probe fails; the control is unavailable |
| `WindowsPowerSettingAdapter` | The subgroup and setting GUIDs, and `/setacvalueindex` behaviour | Probe fails; those controls are unavailable |
| Elevation behaviour | Which power settings actually require Administrator on this machine | Writes fail with a permission error, which is surfaced, not swallowed |
| `install-nexus.ps1` | Task Scheduler registration on the target machine | Task is not registered; NEXUS does not start at logon |

## MOCKED / SIMULATED

Deliberately synthetic. Everything derived from these is labelled `mocked` and
can never be reported as `live`.

- `MockHardwareProvider` and the `target-desktop` / `minimal-unknown` fixtures.
  The target fixture models a Ryzen 9 9950X, RX 7900 XT with 20 GB, and 96 GB
  of DDR5. It is a *model of* that machine, not a reading of it.
- `MockTelemetrySource` — deterministic simulated readings.
- `MockControlAdapter` — in-memory controls used for simulation and tests.
- `LinuxHardwareProvider` / `LinuxTelemetrySource` are **not** mocks: they read
  this host and are `live` on Linux. They exist so the abstraction stays honest
  during development. They are not a Windows substitute.

## NOT IMPLEMENTED

Absent by decision, and registered as explicitly unavailable capabilities so a
request for them is refused with a reason rather than an "unknown capability".

| Capability | Why |
|---|---|
| CPU die temperature, package power, per-core clocks | No in-box Windows interface exposes these on a desktop AM5 board. They require a ring-0 helper. See the sensor bridge in [telemetry.md](telemetry.md). |
| GPU temperature, hotspot, fan RPM, board power, GPU clocks | Requires AMD's ADLX library, which ships inside the display driver and has no command-line or WMI surface. See [dependencies.md](dependencies.md). |
| Process enumeration and foreground detection | Not implemented. Workload classification runs without process evidence, and says so by listing `process.enumerate` in its missing signals. |
| Process priority control | Depends on process enumeration. |
| Fan control | Prohibited by policy — an incorrect curve is a thermal hazard NEXUS cannot recover from if it loses the interface mid-change. |
| GPU and CPU silicon tuning | Prohibited by policy — validating an overclock safely requires a stress methodology NEXUS does not own. |
| Tray / GUI | Not built. NEXUS is a CLI and a background process. |
| Vesper itself | Out of scope by instruction. NEXUS defines the contract; it does not implement the other side. |
