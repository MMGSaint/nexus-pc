---
name: nexus-research
description: Research vendor documentation, Windows APIs, AMD SDKs, sensor helpers, benchmark tools, and prior art before NEXUS reinvents a capability. Use before introducing unfamiliar infrastructure, hardware control, optimization algorithms, telemetry providers, or external dependencies.
metadata:
  author: Yeager
  short-description: NEXUS prior-art research
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Research

Before inventing infrastructure, search for mature prior art. Then stop at a decision label. Do not accumulate dependencies because a project looks useful.

NEXUS currently needs only Node.js 20.11+ and in-box Windows tools (PowerShell, CIM, powercfg). See `docs/dependencies.md`.

## Research order
1. official or vendor documentation
2. active upstream repository
3. current releases and changelog
4. issues and security advisories
5. comparable tools
6. license and dependency review via nexus-provenance

## Recurring candidates
LibreHardwareMonitor, PresentMon, CapFrameX, AMD ADLX, GPUPerfAPI, TraceEvent/PerfView, Universal x86 Tuning Utility, ZenStates-Core, RyzenAdj, FanControl, Process Governor, Affix, Optuna, Nevergrad, River, Vowpal Wabbit.

These are research targets, not automatic dependencies.
WinRing0 is rejected (CVE-2020-14979 / BYOVD).
`MSAcpi_ThermalZoneTemperature` is not a CPU-die substitute.
HWiNFO shared memory has restrictive terms — read them before any use.
ADLX ships inside the AMD driver as `amdadlx64.dll`. The GitHub SDK is headers and samples, not a redistributable.

## Decision labels
REUSE AS DEPENDENCY / WRAP WITH ADAPTER / STUDY FOR DESIGN / USE FOR TESTING / REJECT

Prefer the sensor-bridge pattern already specified over embedding a ring-0 driver in the NEXUS process.
