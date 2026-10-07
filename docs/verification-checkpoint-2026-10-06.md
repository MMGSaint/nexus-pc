# NEXUS PC — Verification Checkpoint — 2026-10-06

This document is the current verification ledger. It exists to prevent repeating tests that already passed and to make the next session start from the actual frontier.

## Current checkpoint

**Repository:** `MMGSaint/nexus-pc`  
**Current GitHub main:** `3a8f1bd4ac418a9fd87079faa3dd5c3836ebc91f`  
**Latest completed full local verify:** `641560a90dc33ff8016ee24f2eaed5dd844a064e`  
**Latest completed full verify result:** PASS — 35 test files, 471 tests passed, typecheck/lint/build/test all green.  
**GitHub individual commit-status entries:** none reported for `641560a`; local verification is the authoritative result currently being used.

### Target PC actually observed

- OS: Windows 11 Home
- CPU: AMD Ryzen 9 9950X 16-Core Processor
- GPU: AMD Radeon RX 7900 XT
- VRAM: 20 GB
- RAM: 96 GB
- Note: older design docs/fixtures reference a Ryzen 9 9950X3D. The real target detected during this session is **9950X (non-X3D)**. Do not silently treat the machine as 9950X3D.

## Tests already completed — DO NOT REPEAT unless code changes affect them

### Automated suite / static gates

Passed at `641560a`:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run test`
- `npm run verify`
- 35 test files / 471 tests passed
- Build assets copied successfully
- `git diff --check` was clean
- Built CLI help works
- Built CLI version works and reported:
  `NEXUS 0.1.0 (Vesper contract 1.0.0, Node v24.20.0)`

### Regression fixes already verified in code

1. **Windows PowerShell executable resolution**
   - Root bug: `powershell.exe` was resolved to `%SystemRoot%\\System32\\powershell.exe`.
   - Fixed to the real Windows PowerShell 5.1 location:
     `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`.
   - Regression coverage added.
   - The path test was made host-independent with `path.win32.join`.
   - Commits:
     - `1af2632db83418d5dd72f630c1834b3650708b2e`
     - `ca4ea7a09ebf313abd7dcaf47ee8fceb9dee9c34`
     - `8e7231fdfd98aef48ec0e5da27e15916d93b435d`

2. **Built CLI audit verification timeout**
   - Failure reproduced in `tests/cli/cli.test.ts`: built CLI audit-chain verification timed out because the audit command unnecessarily booted the whole runtime.
   - Fixed so audit inspection uses the event log directly and does not wait for hardware/runtime initialization.
   - Commit: `641560a90dc33ff8016ee24f2eaed5dd844a064e`
   - Full suite then passed 471/471.

3. **Wardogs workload recognition**
   - The classifier had process hints for other games but not Wardogs, so `medalencoder.exe` could dominate and classify an active Wardogs session as development.
   - Added `wardogsclient` as a gaming corroborator.
   - Regression test added using `WardogsClient-Win64-Shipping.exe`, foreground=true, CPU/GPU activity.
   - Commits:
     - `7890124ee66d430c00d6eb18524993666a63c6b5`
     - `3a8f1bd4ac418a9fd87079faa3dd5c3836ebc91f`
   - **These two latest commits have NOT yet been run through the user's local `npm run verify` at this checkpoint.**

## Target Windows validation already completed

### Real hardware discovery

A real `first-pc` run successfully discovered:

`AMD Ryzen 9 9950X 16-Core Processor | AMD Radeon RX 7900 XT | 20 GB VRAM | 96 GB RAM | Microsoft Windows 11 Home`

This cleared the earlier `powershell.exe ENOENT` discovery failure.

### Real telemetry

A 30-second target-PC observation produced live readings including:

- CPU clock mean: ~4300 MHz
- CPU utilization: 29.8%, coverage 100%
- GPU utilization: 36.6%, coverage 100%
- GPU VRAM used: ~6.5 GiB
- Memory total: ~95.6 GiB
- Memory available: ~61.7 GiB
- Memory used: ~33.8 GiB
- NEXUS self CPU mean: ~1.3%, max ~5.4%

The self-CPU budget guard engaged during runs and reduced telemetry interval when process overhead exceeded the configured 2% budget. This is expected protective behavior, not a test failure.

### Real process enumeration

Windows `tasklist.exe` worked on the target. During the Wardogs session it reported:

`WardogsClient-Win64-Shipp 40104 Console ...`

The full executable is known from the process/classifier work as `WardogsClient-Win64-Shipping.exe`.

Process evidence is currently usable as corroboration.

### Real runtime / health state

After the Windows PowerShell path fix, the target showed:

- hardware discovery: live
- telemetry: live
- baseline: available
- audit chain: intact
- no failed checks
- capabilities increased from the earlier degraded state to 13/27

A real `first-pc` run completed successfully but skipped controlled optimization because workload confidence was below the 60% action floor.

### Safety behavior verified

The workload classifier correctly refuses to cross the action threshold when evidence is insufficient. The optimizer therefore did **not** force a power/profile change just because the user was gaming.

This is intentional and should not be weakened to make the demo run.

### Configuration state already changed

Target mode was set to:

`assisted`

Vesper remains disabled by default.

## Known root cause for the current remaining gate

The native Windows helper already exists in the repository and is designed to provide foreground-process evidence, but the target machine has not yet had the helper built, SHA-pinned, and configured.

Without foreground evidence:

- `gpu.vram.total` is still unknown in the observed telemetry
- `process.foreground` is unavailable
- the classifier can still cap confidence
- unrelated development processes such as `medalencoder.exe` can compete with the game signal

The safety floor is currently 0.60 and must remain intact.

## CURRENT FRONTIER — next work only

Do these in order; do not rerun unrelated tests first:

1. Pull `origin/main` so the local checkout gets commits `7890124` and `3a8f1bd`.
2. Run one `npm run verify` to validate those two latest classifier changes locally.
3. Build the existing native Windows helper with:
   `powershell -ExecutionPolicy Bypass -File .\\tools\\native-windows-helper\\build.ps1`
4. Smoke-test the helper's `foreground` command.
5. Configure its absolute path + SHA-256 in `%LOCALAPPDATA%\\NEXUS\\config.json`.
6. Run `nexus doctor` and confirm `process.foreground` is available.
7. With **Wardogs actually foreground**, run one 30-second `observe`.
8. Run `first-pc` once from that real gaming state.
9. Only after that result should controlled optimization / rollback behavior be exercised.

## Explicitly NOT YET VERIFIED on the target

- Native helper foreground detection on the target
- Wardogs gaming classification after the new Wardogs hint is installed locally
- A real controlled power/profile change followed by measured keep/rollback on the target
- Administrator/elevation behavior for actual power-setting writes
- LibreHardwareMonitor sensor bridge on the target
- PresentMon frame-truth integration on the target
- OpenXR runtime detection on the target
- Real driver-identity baseline matching on the target
- Startup/task-scheduler installation behavior on the target

## Red-team notes to retain

- Do not lower the 60% action-confidence floor just to make controlled optimization fire.
- Do not manually change the power plan before the controlled-change test; let NEXUS checkpoint, write, measure, and decide.
- Do not call the current target CPU an X3D CPU. Detection says 9950X.
- Do not treat missing `gpu.vram.total` as zero.
- Do not classify from process names alone; process evidence is corroboration, not authority.
- "Skipped because evidence was insufficient" is a successful safety outcome.

## Stop point

At this checkpoint, the codebase has a green full verification gate through `641560a`, real Windows hardware/telemetry/process enumeration has been exercised successfully, and the remaining work is a narrow target-integration gate rather than a general debugging pass.
