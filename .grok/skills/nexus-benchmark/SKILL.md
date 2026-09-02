---
name: nexus-benchmark
description: Produce honest before/after evidence for NEXUS, detect regressions, and label what the current measurement window can and cannot prove. Use for performance validation, tuning experiments, regressions, or deciding whether a change is beneficial.
metadata:
  author: Yeager
  short-description: NEXUS evidence engine
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Benchmark

A tuning change is useful only if measurement demonstrates a meaningful outcome.
Current measurement — `src/optimizer/measure.ts` plus telemetry summaries. Default window is about 20 seconds of high-resolution sampling.

## What NEXUS can measure now
Paired before/after means over a short window, with conservative noise floors.
Detectable — coarse utilization shift, thermal rise when a temperature reading exists (8 C is the hard regression stop), whether a write stuck.

## What NEXUS cannot measure now
FPS, frame-time percentiles, 1 percent lows, frame pacing, input latency, stutter, board power, fan RPM, and process identity.
PresentMon and CapFrameX are research targets. They are not integrated.
"No measurable benefit" means NEXUS could not measure a benefit, not that none exists.

## Verification classes
Always label results as one of
- VERIFIED ON TARGET HARDWARE
- VERIFIED LOCALLY WITHOUT TARGET HARDWARE
- MOCKED / SIMULATED
- IMPLEMENTED BUT UNVERIFIED
- BLOCKED BY HARDWARE / CREDENTIALS / EXTERNAL API

Nothing in this repository has run on the target Windows machine. Linux tests and `--simulate target-desktop` are not that class.

## Reporting
Quantify tradeoffs that were actually measured. Preserve workload, mode, fidelity, coverage, and window length.
Do not optimize on a single noisy sample. Do not promote a compile or a green unit suite into a hardware win.
