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
| WARDEN evidence | PresentMon frame truth, displayed/presented/application FPS, generated-frame awareness, display-latency evidence, driver-stamped baselines, staged game-state reconciliation, and VR capability isolation |
| Staged startup | Health answerable during initialization; failures degrade rather than stop; required stages gate readiness |
| Graceful shutdown | Ordered, bounded, idempotent; session marked clean; background init awaited |
| Profiles | Built-in profiles validate against the policy; user profiles rejected for unknown fields, prohibited controls, out-of-policy values |
| Workload classification | Confidence floors; missing signals cap confidence; `unknown` is a normal answer; context hints corroborate but never override; conflicts reported |
| Vesper interface | Path-based transport only; token auth; scope enforcement with mutating scopes ungranted by default; strict payload validation; depth/size/rate bounds; fidelity on every response |
| Process execution | Executable allowlist; no shell; dynamic values passed via environment, never interpolated into script text; NUL rejection |
| Windows discovery parsing | `qwMemorySize` preferred over `AdapterRAM`; saturated `AdapterRAM` rejected; powercfg output parsing; DDR5 detection; EXPO-not-applied warning |
| Process enumeration (portable) | Linux `/proc` enumerator (pid, comm, optional RSS); Windows `tasklist` CSV parsing with foreground-process enrichment; capability probe success→available / failure→unavailable; classifier receives process evidence as optional corroboration (never overrides telemetry); capped sample ranked by working set |

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
| `install-nexus.ps1` | Task Scheduler registration on the target machine | Task is not registered; NEXUS does not start at logon; the script is intentionally per-user and does not require the NEXUS runtime to be online. |
| `WindowsProcessEnumerator` (`tasklist`) | `tasklist.exe /FO CSV /NH` output shape and foreground-window access on real Windows | Probe fails; `process.enumerate` stays unavailable; classification runs without process evidence and lists it in `missingSignals` |

| `LibreHardwareMonitorSource` | Real LHM web endpoint payloads and sensor naming on the target | Source becomes unavailable/invalid; thermal-gated controls remain refused |
| `PresentMonCollector` / frame truth | PresentMon installation/version and real frame-type/display attribution on the target | Frame evidence is unavailable; benefit decisions fall back to the available measured evidence |
| OpenXR active-runtime probe | Real registry/runtime manifest state on the target | VR capability is reported unavailable/unsupported; VR-specific changes are refused |
| Display driver identity | Real `Win32_PnPSignedDriver` result on the target | Driver identity is unavailable; a matching baseline is not assumed across unknown driver state |

## MOCKED / SIMULATED

Deliberately synthetic. Everything derived from these is labelled `mocked` and
can never be reported as `live`.

- `MockHardwareProvider` and the `target-desktop` / `minimal-unknown` fixtures.
  The target fixture models a Ryzen 9 9950X3D, RX 7900 XT with 20 GB, and 96 GB
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
| CPU die temperature, package power, per-core clocks | Requires the separate LibreHardwareMonitor bridge; NEXUS does not vendor its driver/library. |
| GPU temperature, hotspot, fan RPM, board power, GPU clocks | Requires live sensor evidence from the separate LHM bridge and/or a future AMD adapter; NEXUS does not vendor ADLX. |
| Process foreground detection | Implemented through the Windows foreground-window probe and used only as corroborating evidence / PresentMon target ranking; still hardware dependent on the target PC. |
| Process priority control | Depends on process enumeration (now available) plus a write adapter that is not implemented. Remains registered as unavailable. |
| Fan control | Prohibited by policy — an incorrect curve is a thermal hazard NEXUS cannot recover from if it loses the interface mid-change. |
| GPU and CPU silicon tuning | Prohibited by policy — validating an overclock safely requires a stress methodology NEXUS does not own. |
| Tray / GUI | Not built. NEXUS is a CLI and a background process. |
| Vesper itself | Out of scope by instruction. NEXUS defines the contract; it does not implement the other side. |

## Development infrastructure

Software-only; no target-PC validation is implied.

| Item | Status |
|---|---|
| Continuous integration workflow | Runs the local verify gate on pushes and pull requests to main on both Ubuntu and Windows runners. |
| Windows CI coverage | Exercises the Windows code paths under the real Windows runtime, but does not substitute for validation on the target PC or prove AMD-specific telemetry/sensor behaviour. |

## Mature-stack notes

The merged hardening follows the same useful separation seen in mature desktop tooling: process/library orchestration stays distinct from hardware backends, frame timing is collected by a dedicated truth source instead of reconstructed in-process, and user-facing profile selection remains separate from machine-control authority. Playnite, FanControl, MangoHud and Special K were used as architectural references only; no third-party source was vendored from them.

## Private primary-target specialization

The private development target is Ryzen 9 9950X3D + Radeon RX 7900 XT 20 GB + 96 GB DDR5. The specialization layer recognizes this target and prevents automatic generic profiles from changing whole-package core parking or the processor minimum state until the X3D-specific measurement stack is present. This is a strategy guard, not a replacement for the deterministic safety kernel.
