---
name: nexus-orchestrator
description: Route NEXUS work to the smallest sufficient specialist skill set and enforce the observe-propose-validate-apply-measure-learn workflow. Use for any non-trivial NEXUS task, especially cross-cutting requests or when the correct specialist is unclear.
metadata:
  author: Yeager
  short-description: NEXUS task router
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Orchestrator

NEXUS is an adaptive control system, not a pile of tuning commands and not Vesper.

Repository of record — `MMGSaint/nexus-pc`. Inspect that tree before routing. Do not invent modules that are not in the repo.

## Primary loop
OBSERVE -> MODEL -> PROPOSE -> VALIDATE -> APPLY -> MEASURE -> LEARN -> COMMIT/ROLLBACK

The implemented pipeline in `src/optimizer/engine.ts` and `docs/optimization.md` is
OBSERVE -> BASELINE -> PROPOSE -> VALIDATE -> APPLY -> MEASURE -> KEEP/ROLLBACK.
Learning currently means structured outcome reports. It is not an online trainer.

## Routing
- system design / boundaries / new subsystems -> nexus-architect
- sensors / readings / sampling / sensor bridge -> nexus-telemetry
- hardware or OS actuation adapters -> nexus-control + nexus-safety
- proposals / objectives / keep-or-rollback policy -> nexus-optimizer
- outcome memory / workload fingerprints / future adaptation -> nexus-learning
- kernel, policy, rollback, recovery, fail-closed behavior -> nexus-safety
- before/after evidence and measurement honesty -> nexus-benchmark
- prior art before new infrastructure -> nexus-research
- licenses / copied code / dependency decisions -> nexus-provenance

## Composition examples
New adaptive tuning feature
architect -> telemetry -> optimizer -> safety -> control -> benchmark -> learning

New external project
research -> provenance -> architect -> relevant implementation skills -> benchmark

Hardware-control change
safety -> control -> telemetry -> benchmark

Performance regression
benchmark -> telemetry -> architect -> targeted implementation -> benchmark

Future-facing learning
benchmark -> learning -> optimizer -> safety

## Rules
- Use the smallest sufficient set.
- The language model may plan and explain. It may not actuate or widen policy.
- Separate observation from actuation.
- Never treat a mock, fixture, or Linux host read as target-Windows verification.
- Surface unknowns and blockers instead of inventing facts.
- Do not merge NEXUS into Vesper. The contract is `src/vesper/` and `docs/vesper-interface.md`.
