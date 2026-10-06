# NEXUS native Windows bridge

The private build uses a small self-contained .NET helper for Windows APIs that Node.js does not expose directly.

## Current observations

- Foreground-window PID and process name.
- Windows CPU Set enumeration: CPU Set ID, processor group, logical-processor index, core index, last-level-cache index, NUMA node, efficiency class, and allocation/parking flags.
- A process's current default CPU Set assignment.

## Current reversible action

The helper can set and verify a process default CPU Set list. NEXUS wraps that capability in `WindowsProcessPlacementController`, which creates a drift-checked plan and keeps the prior assignment for rollback.

That controller is **not yet wired into automatic optimization**. The point of this stage is to prove the native contract and evidence flow before allowing an autonomous scheduler to act.

Windows documents CPU Sets as a soft affinity mechanism that cooperates with power management. SetProcessDefaultCpuSets changes the process-default assignment inherited by new threads that do not have their own selected CPU Sets.

## Build

From a Windows development shell:

powershell -ExecutionPolicy Bypass -File .\tools\native-windows-helper\build.ps1

Do not place the helper on PATH. Put the resulting `nexus-native-helper.exe` at a fixed local path and configure that absolute path as `tools.nativeHelperPath` in NEXUS. For stronger supply-chain protection, also set `tools.nativeHelperSha256` to the SHA-256 of the exact binary.

## Authority boundary

The helper is deliberately dumb:

**NEXUS chooses** the target PID, the CPU Set IDs, when the operation is allowed, whether evidence is fresh enough, and whether rollback is required.

**The helper performs** exactly the requested Win32 operation and reports the observed result. The caller must identify the exact executable path; NEXUS never falls back to PATH for this third-party helper.

The helper never chooses a process, never interprets a game profile, never decides that a cache domain is beneficial, and never elevates a model/Vesper request.

See Microsoft's CPU Sets API documentation and the Windows CPU Sets concept documentation for the OS contract.
