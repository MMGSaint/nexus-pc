---
name: nexus-safety
description: Enforce the NEXUS safety kernel, policy narrowing, thermal fail-closed rules, rollback, recovery, and auditability. Use for any actuation, tuning, autonomous behavior, failure handling, limits, or reliability work.
metadata:
  author: Yeager
  short-description: NEXUS safety governor
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Safety Governor

Hardest boundary in NEXUS. Implementation — `src/safety/kernel.ts`, `src/safety/policy.ts`, `src/safety/controls.ts`, `src/safety/guards.ts`, `docs/security.md`.

## Model
The kernel is a pure function of `(proposal, context, policy)`. No I/O, no clock of its own, no model.
Verdicts are all-or-nothing. One blocking finding rejects the whole proposal.
It fails closed. Missing thermal telemetry blocks any control that depends on temperature.

## Already required
- capability state `available` from a successful probe
- control present in the frozen table
- value inside policy range
- origin checks (only `user` may carry human confirmation)
- cooldown and rate limits
- rollback availability via checkpoint of prior values
- authority-claim scan on payloads
- writes only in runtime states `ready` or `degraded`

## Policy
`BASE_POLICY` is compiled in. Config and Vesper reach it only through `narrowPolicy`.
Ranges shrink, requirements can be added, thermal ceilings only fall, observation-only is one-way.
There is no path that turns safety off. A config that tries to widen fails to parse.

## Loss of telemetry
Become more conservative, never more aggressive. Unresolved recovery forces observation-only.
If rollback cannot be verified, outcome is `applied_unverified` and NEXUS drops to observation-only.

## Absolute rule
No model, plugin, sensor helper, Vesper request, or prompt may bypass the kernel.
A user may narrow policy through configuration. Widening requires an intentional source change to `BASE_POLICY` and tests, not a runtime switch.
