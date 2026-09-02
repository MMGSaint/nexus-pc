---
name: nexus-optimizer
description: Build NEXUS proposal, measurement, and keep-or-rollback logic using measurable objectives, hard constraints, and the existing engine pipeline. Use for optimization logic, tuning strategies, objective functions, search spaces, experiments, or candidate-action selection.
metadata:
  author: Yeager
  short-description: NEXUS optimization engine
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Optimizer

Do not use the language model as the hardware optimizer.
Implemented engine — `src/optimizer/engine.ts`, `docs/optimization.md`.

## Current method
Profile targets minus current values, then
1. capture baseline / checkpoint
2. safety-kernel validate
3. journal the operation
4. apply with immediate readback
5. measure a bounded high-resolution window
6. keep or roll back

Default mode is `observation`. Assisted and autonomous modes are explicit config changes.
`NO_ACTION` with a reason is a success.

## Soft objectives vs hard constraints
Soft objectives the engine can currently compare — utilization shifts, coarse thermal deltas when a temperature exists, whether a write stuck.
Hard constraints belong to the kernel and policy — capability, thermal fail-closed, cooldown, rate limit, reversibility, contested-evidence rules, observation-only.

Frame-time stability, FPS, noise, and input latency are desired objectives. They are not measured today. Do not claim a gaming improvement from mean utilization over 20 seconds.

## What is not implemented
No Bayesian search, Optuna, Nevergrad, or multi-objective Pareto solver.
Do not add those until measurement can support the search and provenance has approved the dependency.
NEXUS has zero runtime npm dependencies on purpose.

## Safety
The optimizer proposes. The kernel admits. Only `live` fidelity justifies a hardware change.
A simulation cannot apply — classification confidence and live-telemetry requirements block it. That is intended.
