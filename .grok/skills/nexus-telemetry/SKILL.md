---
name: nexus-telemetry
description: Design and normalize NEXUS hardware, OS, and workload telemetry, including Windows CIM sources, the sensor bridge, validation, and adaptive sampling. Use for sensors, monitoring, workload detection, hardware state, or telemetry storage.
metadata:
  author: Yeager
  short-description: NEXUS telemetry layer
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Telemetry

Telemetry is evidence, not authority. Authoritative model is `docs/telemetry.md` and `src/domain/telemetry.ts`.

## Current sources
- `nexus.self` — own CPU and RSS. Tested.
- `os.memory` — system memory. Tested.
- `windows.perfcounters` — CPU utility/clock, GPU utility, VRAM in use. Hardware-dependent. Never executed on the target PC.
- `linux.procfs` — live on the Linux development host. Not a Windows substitute.
- `mock.simulated` — fixtures. Always `mocked`.
- `sensor.bridge` — optional JSON file in the NEXUS runtime directory. Unavailable until a helper exists.

PresentMon, ETW/TraceEvent, ADLX, GPUPerfAPI, and LibreHardwareMonitor are research targets, not implemented providers.

## Quality rules already encoded
A reading is `ok` if and only if `value !== null`. Rejected values become `invalid` with `null`, never zero.
Every reading carries timestamp, source, unit, status, fidelity, and confidence.
Plausibility bounds live in `src/telemetry/validation.ts`.
CPU utility is bounded at 200 percent because Windows Processor Utility can exceed 100 percent.
CPU clock is bounded at 200-7500 MHz to catch APERF/MPERF corruption after suspend.

## Sampling
Modes in the pipeline — `low_activity`, `active_workload`, `optimization`, `suspended`.
Optimization sampling is bounded. Self-CPU over budget lengthens the interval.

## Honest gaps
No in-box Windows path for CPU die temperature, GPU temperature, hotspot, fan RPM, or board power.
Without the sensor bridge those capabilities stay `unavailable` and thermal-gated controls fail closed (`THERMAL_UNVERIFIABLE`).
No frame-time, 1 percent low, or process-enumeration source exists.
Do not treat noisy telemetry as an actuator input. Filter through validation, hysteresis, dwell, and the kernel.
