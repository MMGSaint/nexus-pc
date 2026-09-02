---
name: nexus-control
description: Design NEXUS actuation adapters for Windows power settings and other reversible OS controls with capability detection, readback, and rollback. Use for changing power-plan settings, process behavior, or other system controls that already exist in the frozen control table.
metadata:
  author: Yeager
  short-description: NEXUS control adapters
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Control

Actuation must be explicit, bounded, observable, and reversible.
Path — optimizer proposal -> safety kernel -> checkpoint -> actuator -> readback.

## What is implemented
Writable power-plan adapters in `src/optimizer/actuators/windows-power.ts`.
Controls in `src/safety/controls.ts` that are actually auto-proposable today
- `power.scheme.active`
- `power.processor.boost_mode`
- `power.processor.min_state`
- `power.processor.max_state`
- `power.processor.core_parking_min`
- `power.pcie.aspm`

These adapters are written and unit tested. They are hardware-dependent and have not run on the target Windows machine.

## Registered but not live
- Process priority requires `process.enumerate`, which is not implemented.
- Game Mode, HAGS, and MMCSS settings are contested and not auto-proposed. Some require reboot.

## Prohibited by policy
Do not implement actuation for
- GPU core/voltage offsets
- CPU package power limits / PBO-style silicon tuning
- custom fan curves
- working-set trimming

AMD ADLX, ZenStates-Core, RyzenAdj, and FanControl are research targets. They are not adapters in this repo. Fan and silicon tuning stay prohibited even if a library exists.

## Every actuator needs
- capability probe before use
- explicit allowed range from the frozen descriptor
- current-state read
- apply
- immediate readback
- failure path that does not pretend success
- checkpointed rollback
- audit record
- fidelity clamp so a mock cannot report `live`

Never invent a control that is not in `src/safety/controls.ts`. There is no registration API.
