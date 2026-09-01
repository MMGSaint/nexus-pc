# Startup, residency and shutdown

## Why not a Windows service

NEXUS runs as a **per-user background process started by Task Scheduler at
logon**, not as a Windows service. Three reasons:

1. A service runs in session 0 and cannot show UI, so any user-facing surface
   would need a second process anyway.
2. NEXUS's work is per-user and per-session. Nothing it does needs to happen
   before someone logs in.
3. A logon task can be registered by a standard user for their own account with
   no elevation at all. A service always needs an administrator to install.

"Startup" sounding like a service problem is not a reason to create one.

```powershell
# From the repository root, after npm run build
.\scripts\windows\install-nexus.ps1

# Removes the task. Does not revert settings or delete state.
.\scripts\windows\uninstall-nexus.ps1
```

The task is registered at **normal integrity by default**. NEXUS then reports
any control that needs elevation as an unavailable capability, rather than
silently failing to apply it. `-Elevated` registers it with highest privileges
so power-scheme writes succeed; that switch requires an administrator and is a
real increase in what NEXUS can do to the machine.

The trigger has a 30 s delay so NEXUS does not compete with everything else
starting at logon.

## Staged startup

Startup is **fast, non-blocking and recoverable**. `start()` brings up the
critical core and returns; the slow work continues in the background.

| Stage | Blocking? | What it does |
|---|---|---|
| `core` | yes | Instance lock, session record, restart guard, component registration |
| `health` | yes | Health reporting becomes answerable — deliberately early |
| `audit` | yes | Open the event log, verify its hash chain, record session start |
| `recovery` | yes | Reconcile operations left unfinished by a previous session |
| `telemetry` | background | Construct and start sources, take a first sample |
| `hardware` | background | Discovery |
| `capabilities` | background | Probe everything |
| `profiles` | background | Load and validate |
| `baseline` | background | Load the latest, or capture one |
| `optimizer` | background | Accept requests |
| `vesper` | background | Start the local IPC endpoint, if enabled |

Until the required stages complete, NEXUS reports `initializing` and lists
which stages are outstanding. **It never reports ready because the process
exists.** A stage that fails degrades NEXUS rather than stopping it, and the
reason appears in `degradedReasons`.

## Single instance

The authoritative lock is an OS rendezvous point that only one process can hold
and that the kernel releases when the holder dies: a named pipe on Windows, a
unix domain socket on POSIX. A PID file alone is not enough — PIDs are reused,
a stale file outlives a crash, and "is this PID alive?" says nothing about
whether the live process is NEXUS.

On POSIX the socket *file* survives a crash, so a leftover file is probed by
connecting to it; a refused connection means the holder is gone and the file
can be removed.

A descriptive `runtime/instance.json` sits alongside carrying no authority — it
exists so a human can see *who* holds the lock and since when.

This covers double-clicks, a logon task racing a manual launch, crash-recovery
overlap and reboot overlap. The second instance exits with a clear message
naming the holder.

## Restart guard

Start timestamps are counted in a rolling window (5 starts in 5 minutes by
default). Past that threshold NEXUS comes up in **observation-only** mode
instead of trying whatever killed it again. Once a session proves stable the
counter is cleared. Bounded retries, never an unbounded loop.

## Graceful shutdown

```
stop accepting work → await background init → stop sampling →
close the Vesper endpoint → flush the audit record → prune →
mark the session clean → release the lock → exit
```

Every step has a deadline, so shutdown cannot hang. It is idempotent, and
`SIGINT`/`SIGTERM` are handled so a console Ctrl+C shuts down in order.

The session record is marked `cleanShutdown: true` **only** by this path — which
is exactly what makes crash detection on the next start reliable.
