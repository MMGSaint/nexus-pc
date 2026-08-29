# NEXUS

A PC performance and hardware specialist for Windows desktops.

NEXUS observes the machine, understands what it is doing, and applies
reversible optimizations — but only within a deterministic safety policy it
cannot be talked out of, and only after it can prove it read the hardware
correctly.

It ships in **observation mode**. It measures and reports and changes nothing
until a human says otherwise.

```
npm ci
npm run verify          # typecheck, lint, 362 tests, build
node dist/cli/main.js doctor
```

## What it is

- **Zero runtime dependencies.** Every byte crossing a trust boundary is parsed
  by code in this repository.
- **Hardware discovery** that reports what it does not know as unknown, and
  reads video memory from a source that is actually correct above 4 GiB.
- **Telemetry** where "unavailable" can never be confused with zero, and
  implausible readings are rejected rather than acted on.
- **A deterministic safety kernel** that no configuration, no model output and
  no orchestrator can widen, bypass or disable.
- **Checkpointed, measured, reversible changes** — or an honest refusal.
- **A hash-chained audit trail** of every decision.
- **A local-only Vesper interface.** No network listener, anywhere.

## Two rules the whole design follows

**Unknown is never zero.** A reading either has a real number and status `ok`,
or it has `null` and a status saying why. A system that quietly substitutes
zero for a missing sensor will eventually decide the GPU is idle and cold when
it is neither.

**A mock can never impersonate real hardware.** Every artifact carries a
fidelity; combination takes the weakest input; providers are clamped to their
registered trust. A fixture cannot return a `live` success, whatever it claims.

## Commands

```
nexus doctor                    # full diagnostic, including what it cannot do here
nexus discover                  # hardware inventory
nexus observe --seconds 120     # watch telemetry, change nothing
nexus baseline capture          # record the machine before anything is touched
nexus profiles show gaming      # exactly what a profile changes, and why
nexus controls                  # every control, with its safety class
nexus recommend                 # what it would do, without doing it
nexus optimize --dry-run        # validate the full pipeline, change nothing
nexus optimize --require-benefit# apply, measure, roll back unless it helped
nexus checkpoints / rollback ID # recovery
nexus audit verify              # check the audit chain
nexus first-pc                  # guided first-deployment validation
nexus run                       # resident background process
```

Add `--json` to any command. Add `--simulate target-desktop` to run against a
fixture modelling a Ryzen 9 9950X / RX 7900 XT / 96 GB machine — everything
produced that way is labelled `mocked`.

## Documentation

| | |
|---|---|
| [Implementation status](docs/implementation-status.md) | **Start here.** What is tested, what is hardware dependent, what is mocked, what is absent. |
| [Architecture](docs/architecture.md) | Layers, the safety kernel, policy narrowing, the authority model |
| [Hardware detection](docs/hardware-detection.md) | Providers, and the Windows quirks that matter |
| [Telemetry](docs/telemetry.md) | The reading model, validation, adaptive sampling, the sensor bridge |
| [Profiles](docs/profiles.md) | Explicit change sets, validation, writing your own |
| [Optimization](docs/optimization.md) | The pipeline, no-action reasons, operating modes |
| [Rollback](docs/rollback.md) | Checkpoints vs backups vs logs, and scope |
| [Startup](docs/startup.md) | Residency, staged init, single instance, shutdown |
| [Recovery](docs/recovery.md) | Crash detection and reconciliation |
| [Health](docs/health.md) | What health actually answers |
| [Vesper interface](docs/vesper-interface.md) | The integration contract |
| [Dependencies](docs/dependencies.md) | What is needed, and what is not |
| [First-PC init](docs/first-pc-init.md) | The deployment procedure |
| [Security](docs/security.md) | Threat model and enforced properties |
| [Limitations](docs/limitations.md) | Honest rough edges |

## Status

Pre-deployment. **Nothing in this repository has been executed against the
target Windows machine.** The Windows providers and adapters are written and
unit tested but hardware dependent; see
[implementation-status.md](docs/implementation-status.md) for the precise
breakdown, and [first-pc-init.md](docs/first-pc-init.md) for what to do when
the machine is available.

The next milestone is first real PC initialization.
