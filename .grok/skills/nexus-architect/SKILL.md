---
name: nexus-architect
description: Maintain NEXUS architecture, module boundaries, interfaces, state flow, and the Vesper contract across telemetry, optimization, control, and safety. Use for architecture decisions, new subsystems, major refactors, cross-layer features, or interface design.
metadata:
  author: Yeager
  short-description: NEXUS architecture
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Architect

Treat the repository and tests as implementation truth. Treat `docs/` as intended behavior. Start with `docs/architecture.md` and `docs/implementation-status.md`.

## Implemented layers
CLI and local Vesper IPC -> `src/runtime/` -> `src/optimizer/engine.ts`
then safety kernel, checkpoint store, telemetry pipeline, actuators, the machine.

Nothing reaches the machine except through an actuator after the kernel allows it and a checkpoint captures prior values.

## Keep these separated
- telemetry and observation (`src/telemetry/`)
- hardware discovery (`src/hardware/`)
- capability probes (`src/capabilities/`)
- workload classification (`src/workload/`)
- optimizer / proposal / measure (`src/optimizer/`)
- safety kernel and frozen control table (`src/safety/`)
- actuation adapters (`src/optimizer/actuators/`)
- checkpoints, journal, recovery (`src/checkpoint/`, `src/optimizer/journal.ts`, `src/runtime/recovery.ts`)
- profiles and user policy (`src/profiles/`, `src/config/`)
- Vesper contract (`src/vesper/`) — path IPC only, no network listener
- platform providers (Windows, Linux, mock)

There is no experiment-manager module, no online learning subsystem, no frame-time collector, and no tray/GUI.

## Invariants
- Unknown is never zero.
- A mock cannot impersonate live hardware. Fidelity combines by minimum (`src/core/fidelity.ts`).
- `BASE_POLICY` can only be narrowed.
- Controls exist only in the frozen table (`src/safety/controls.ts`).
- Zero runtime npm dependencies. Do not add one without provenance review.

## Decision procedure
1. current implementation evidence
2. desired behavior
3. affected modules
4. data and control flow
5. trust and safety boundaries
6. migration compatibility
7. overhead
8. verification class (software-only vs target hardware)
9. rollback

Do not redesign NEXUS when a focused adapter is sufficient. Do not invent a private Vesper API.
