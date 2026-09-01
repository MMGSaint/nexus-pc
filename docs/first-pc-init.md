# First-PC initialization

The procedure for bringing NEXUS up on the real machine for the first time.
**Observation and evidence come first.** Nothing is tuned until NEXUS has shown
it is reading the hardware correctly.

Target machine: Windows, Ryzen 9 9950X, Radeon RX 7900 XT (20 GB), 96 GB RAM.

---

## 0. Before you start

Requirements: Node.js 20.11+ and this repository. Nothing else.

```powershell
node --version      # expect v20.11 or later
npm ci
npm run verify      # typecheck, lint, build, full test suite
```

`npm run verify` must pass before you go further. It proves the build is intact
on this machine; it says nothing yet about your hardware.

---

## 1. Install and establish startup

```powershell
.\scripts\windows\install-nexus.ps1
```

Registers a logon task at normal privilege. Do **not** pass `-Elevated` yet —
first find out what NEXUS can do without it.

Verify:

```powershell
Get-ScheduledTask -TaskName NEXUS
```

---

## 2. Discover hardware

```powershell
node dist\cli\main.js discover
```

Check every line against the real machine:

| Expect | If wrong |
|---|---|
| `AMD Ryzen 9 9950X`, 16 cores / 32 threads | CIM query failed — check the warnings |
| `AMD Radeon RX 7900 XT` | Adapter not enumerated |
| **20.0 GiB** VRAM, source `registry:HardwareInformation.qwMemorySize` | If ~4 GiB and source is `AdapterRAM`, the registry read failed. The warning will say the figure is a lower bound. Report it; do not proceed as if VRAM is known. |
| **96.0 GiB installed**, usable slightly lower | A large gap means memory is reserved or a module is not enumerated |
| `DDR5` at the speed you configured | If configured is below rated, EXPO/DOCP is not applied in firmware |

**Do not continue if the GPU or memory figures are wrong.** A baseline built on
a wrong inventory is worse than no baseline.

---

## 3. Discover telemetry capabilities

```powershell
node dist\cli\main.js doctor
```

Read the **"What NEXUS cannot do on this machine"** section. On a stock Windows
install with no sensor bridge, expect available: CPU utilisation, CPU clock,
GPU utilisation, GPU VRAM in use, system memory, hardware inventory, and the
power-scheme read/write capabilities (write only if elevated).

Expect **unavailable**: every temperature, power and fan metric. That is
correct — see [dependencies.md](dependencies.md). It means temperature-gated
controls will be refused, which is the fail-closed behaviour working.

If `power.setting.write` is unavailable and you want NEXUS to manage power
plans, re-register the task elevated:

```powershell
.\scripts\windows\install-nexus.ps1 -Elevated   # as Administrator
```

---

## 4. Establish a baseline

```powershell
node dist\cli\main.js observe --seconds 120
node dist\cli\main.js baseline capture
```

Observe first so the baseline has real telemetry in it. Check
`Control coverage` — it is the fraction of writable controls whose current
value NEXUS could read, and it bounds what NEXUS can ever roll back.

---

## 5. Verify profiles

```powershell
node dist\cli\main.js profiles
node dist\cli\main.js profiles show gaming
```

Read exactly what each profile would change and why. If you disagree with any
of it, write your own profile ([profiles.md](profiles.md)) before enabling
anything.

---

## 6. Verify safe controls

```powershell
node dist\cli\main.js controls
```

Confirm the prohibited controls are listed as prohibited: GPU clock and voltage
offsets, CPU power limits, fan curves, working-set trimming. These can never be
changed under any configuration.

---

## 7. Run in observation only

Leave NEXUS in observation mode — its default — for a normal day of use:
gaming, Squad, Where Winds Meet, VRChat, OBS, development, whatever you
actually do.

```powershell
node dist\cli\main.js health
node dist\cli\main.js audit tail --count 40
```

You are checking that NEXUS stays healthy, its self-CPU stays near zero, and
nothing is degraded.

---

## 8. Validate measurements

```powershell
node dist\cli\main.js observe --seconds 300
```

Compare against Task Manager. CPU utilisation above 100% is **correct** under
boost, not a bug. Check that `coverage` is high for the metrics you expect and
that unavailable metrics report as unknown rather than zero.

---

## 9. Run the guided validation

```powershell
node dist\cli\main.js first-pc
```

This runs the whole sequence — discovery, capabilities, telemetry, baseline,
classification, a dry run, and one controlled change configured to roll back
regardless of outcome — and **leaves nothing applied**. It is how the rollback
path gets exercised on the real machine before anything is left changed.

---

## 10. Test one controlled optimization

Only after steps 2–9 look right.

```powershell
node dist\cli\main.js config set-mode assisted
node dist\cli\main.js optimize --profile balanced --dry-run
node dist\cli\main.js optimize --profile balanced --require-benefit
```

The dry run shows what would happen. `--require-benefit` applies, measures, and
rolls back unless a benefit is measured — so the first real change is one that
reverts itself by default.

---

## 11. Measure the outcome

```powershell
node dist\cli\main.js audit tail --count 30
```

Confirm you can see the full arc: `optimization.requested`,
`optimization.validated`, `checkpoint.created`, `optimization.applied`,
`optimization.measured`, and then `optimization.kept` or `rollback.performed`.

---

## 12. Validate rollback

```powershell
node dist\cli\main.js checkpoints
node dist\cli\main.js rollback <checkpointId>
```

Confirm the restore reports **complete**, and that the values are actually back
(`powercfg /query` for the relevant setting).

**Do not skip this.** Rollback working on the real machine is the precondition
for everything after it.

---

## 13. Enable broader optimization only after evidence

```powershell
node dist\cli\main.js config set-mode autonomous
```

Only once discovery is correct, telemetry is trustworthy, a baseline exists,
one controlled change has been measured, and rollback has been proven.

---

## What to report back

If anything in steps 2–4 or 12 does not match, capture:

```powershell
node dist\cli\main.js doctor --json  > nexus-doctor.json
node dist\cli\main.js audit tail --count 100 --json > nexus-audit.json
```

Neither file contains credentials — the audit log is redacted — but read them
before sharing.
