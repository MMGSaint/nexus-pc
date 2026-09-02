---
name: nexus-learning
description: Design NEXUS outcome memory, workload fingerprints, confidence, and future adaptation without expanding the safety envelope. Use for historical evidence, personalization, workload classification, confidence, or adaptive policies.
metadata:
  author: Yeager
  short-description: NEXUS adaptive learning
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Learning

Learning may change NEXUS's beliefs, not its safety envelope.

## What exists today
Workload classification in `src/workload/classifier.ts` uses utilization and memory. Process enumeration is absent, so `process.enumerate` is reported as a missing signal and confidence is capped.
Vesper `declareContext` is evidence with a TTL, never an instruction.
`toOutcomeReport` produces a structured keep / no-benefit / regression / unverified result. NEXUS does not train on it.

There is no River, Vowpal Wabbit, bandit, or reinforcement-learning subsystem.

## Preferred progression
rules -> measured experiments -> statistical adaptation -> online learning -> contextual methods
Move right only when evidence shows the current step is insufficient.

## If adding learning later
Track workload fingerprint, applied profile, measured outcome, variance, stability events, confidence, and conditions.
Keep experiment evidence separate from `BASE_POLICY` and from raw telemetry.
Low confidence must produce more conservative behavior.
No learned model may widen ranges, shorten cooldowns, disable observation-only, or bypass the kernel.
