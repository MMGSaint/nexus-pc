# Implementation status

Every capability in NEXUS falls into one of four categories. This page is the
authoritative list. It exists because the difference between "we wrote an
adapter" and "this works on your machine" is the difference between a useful
tool and a confident liar.

**Target-PC status as of October 6, 2026:** NEXUS has now been executed against
the target Windows 11 machine. Real hardware discovery, live CPU/GPU/memory
telemetry, Windows process enumeration, CLI health/doctor paths, audit
verification, and first-PC orchestration have been exercised successfully.
Several deeper hardware integrations and any real mutating optimization write
remain unverified on the target. See
`docs/verification-checkpoint-2026-10-06.md` for the exact test ledger and
remaining gate.

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

Written and typechecked. Some rows have now been exercised on the target
Windows machine; anything not explicitly marked as target-verified below
remains unverified there. Each component is behind a capability probe, so a
wrong assumption shows up as an unavailable capability rather than an
incorrect action.

| Component | Target status / what remains | Failure mode if wrong |
|---|---|---|
| `WindowsHardwareProvider` | **Target verified:** real Ryzen 9 9950X, RX 7900 XT, 20 GB VRAM, 96 GB RAM and Windows 11 inventory discovered successfully. | Discovery fails; NEXUS degrades and reports no inventory |
| `WindowsTelemetrySource` | **Partially target verified:** live CPU clock/utilization, GPU utilization, and memory telemetry observed for 30 seconds. Deeper sensor sources remain unverified. | Those metrics report `unavailable`; dependent capabilities are unavailable |
| `PersistentShell` | **Exercised on target:** live telemetry depends on the corrected Windows PowerShell path. Longer-running/error-recovery edge cases remain unverified. | Sensor host fails to start; telemetry source degrades |
| `WindowsPowerSchemeAdapter` | **Partially target verified:** active scheme/baseline path is available. A real write and restore have not yet been exercised. | Probe fails; the capability is unavailable; writes surface errors |
| `WindowsPowerSettingAdapter` | **Unverified for mutating writes on target.** | Probe fails or writes return a permission/setting error |
| Elevation behaviour | **Unverified:** no controlled Administrator-only write has been used yet. | Writes fail with a permission error, which is surfaced, not swallowed |
| `install-nexus.ps1` | **Unverified:** Task Scheduler registration on the target has not yet been tested. | Task is not registered; NEXUS does not start at logon |
| `WindowsProcessEnumerator` | **Partially target verified:** `tasklist.exe /FO CSV /NH` works and returned the active Wardogs process. **Foreground-window helper remains unconfigured on target.** | Process enumeration stays unavailable; classification runs without process evidence |
| Native Windows foreground helper | **Implemented, test-covered, but not yet configured on target.** Requires self-contained helper build plus absolute-path SHA pin in config. | Foreground capability remains unavailable; workload confidence may stay below action floor |
| `LibreHardwareMonitorSource` | **Unverified:** real LHM web endpoint payloads and sensor naming on the target. | Source becomes unavailable/invalid; thermal-gated controls remain refused |
| `PresentMonCollector` / frame truth | **Unverified:** PresentMon installation/version and real frame-type/display attribution on the target. | Frame evidence is unavailable; benefit decisions fall back to available measured evidence |
| OpenXR active-runtime probe | **Unverified:** real registry/runtime manifest state on the target. | VR capability is reported unavailable/unsupported; VR-specific changes are refused |
| Display driver identity | **Unverified:** real `Win32_PnPSignedDriver` result and matching-baseline behavior on the target. | Driver identity is unavailable; a matching baseline is not assumed across unknown driver state |

## MOCKED / SIMULATED

Deliberately synthetic. Everything derived from these is labelled `mocked` and
can never be reported as `live`.

- `MockHardwareProvider` and the `target-desktop` / `minimal-unknown` fixtures.
  The historical target fixture models a Ryzen 9 9950X3D, RX 7900 XT with 20 GB,
  and 96 GB of DDR5. It is a *model of* that machine, not a reading of the
  current target, which actually reports a Ryzen 9 9950X.
- `MockTelemetrySource` — deterministic simulated readings.
- `MockControlAdapter` — in-memory controls used for simulation and tests.
- `LinuxHardwareProvider` / `LinuxTelemetrySource` are **not** mocks: they read
  the development host and are `live` on Linux. They are not a Windows substitute.

## NOT IMPLEMENTED

Absent by decision, and registered as explicitly unavailable capabilities so a
request for them is refused with a reason rather than an "unknown capability".

| Capability | Why |
|---|---|
| CPU die temperature, package power, per-core clocks | Requires the separate LibreHardwareMonitor bridge; NEXUS does not vendor its driver/library. |
| GPU temperature, hotspot, fan RPM, board power, GPU clocks | Requires live sensor evidence from the separate LHM bridge and/or a future AMD adapter; NEXUS does not vendor ADLX. |
| Process priority control | Depends on process enumeration (now available) plus a write adapter that is not implemented. Remains registered as unavailable. |
| Fan control | Prohibited by policy — an incorrect curve is a thermal hazard NEXUS cannot recover from if it loses the interface mid-change. |
| GPU and CPU silicon tuning | Prohibited by policy — validating an overclock safely requires a stress methodology NEXUS does not own. |
| Tray / GUI | Not built. NEXUS is a CLI and a background process. |
| Vesper itself | Out of scope by instruction. NEXUS defines the contract; it does not implement the other side. |

## Development infrastructure

Software-only; no target-PC validation is implied unless stated above.

| Item | Status |
|---|---|
| Continuous integration workflow | Runs the local verify gate on pushes and pull requests to main on both Ubuntu and Windows runners. |
| Windows CI coverage | Exercises the Windows code paths under the real Windows runtime, but does not substitute for validation on the target PC or prove AMD-specific telemetry/sensor behaviour. |

## Mature-stack notes

The merged hardening follows the same useful separation seen in mature desktop
tooling: process/library orchestration stays distinct from hardware backends,
frame timing is collected by a dedicated truth source instead of reconstructed
in-process, and user-facing profile selection remains separate from machine-control
authority. Playnite, FanControl, MangoHud and Special K were used as
architectural references only; no third-party source was vendored from them.

## Private primary-target specialization

The current machine reports **Ryzen 9 9950X + Radeon RX 7900 XT 20 GB + 96 GB
RAM**. Some design specialization text still references a Ryzen 9 9950X3D.
That specialization must not be treated as validated for this machine until
its assumptions are reconciled with the detected non-X3D CPU and the required
measurement stack.
