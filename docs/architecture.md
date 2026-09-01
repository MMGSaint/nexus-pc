# Architecture

NEXUS is a single Node.js process with **no runtime dependencies**. Every byte
that crosses a trust boundary — config files, Vesper requests, persisted state,
subprocess output — is parsed by code in this repository. That is a deliberate
trade: a validation library would be less code to write and more code to trust.

## The two invariants

Almost every design decision here follows from one of two rules.

**Unknown is never zero.** A telemetry reading either has a real measured
number and status `ok`, or it has `value: null` and a status explaining why.
The constructors in `domain/telemetry.ts` make the alternative unrepresentable.
The same rule reaches capabilities (`unverified` is not `available`), baselines
(a control that could not be read is recorded as unrestorable), and summaries
(`coverage` shows how much of the window actually produced data). A system that
silently substitutes zero for "the sensor is missing" will eventually decide
the GPU is idle and cold when it is neither.

**A mock can never impersonate real hardware.** Every reading, capability,
decision and outcome carries a `fidelity`. Combination takes the *weakest*
input (`core/fidelity.ts`), and there is deliberately no operation that raises
one. Providers and telemetry sources are registered with a trust level, and the
registry clamps whatever they report to it — so a fixture that returns
`fidelity: 'live'` still records `mocked`. Vesper must never receive a fake
success from a simulator, and this is the mechanism that guarantees it rather
than the convention that hopes for it.

## Layers

```
                      CLI  ──────────────┐
                                         ▼
   Vesper ──[named pipe / unix socket]──► runtime/  (staged startup, health,
                                         │           lock, shutdown, recovery)
                                         ▼
                                   optimizer/engine
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
              safety/kernel        checkpoint/store      telemetry/pipeline
              (deterministic)      (prior values)        (sources, validation,
                    │                    │                adaptive sampling)
                    ▼                    ▼                    │
              safety/controls      optimizer/actuator ◄───────┘
              safety/policy        (read + write + verify)
                                         │
                                         ▼
                                   the machine
```

Nothing reaches the machine except through an actuator, and no actuator runs
except after the safety kernel has allowed it and a checkpoint has captured
what it is about to change.

## The safety kernel

`safety/kernel.ts` is a pure function of `(proposal, context, policy)`. No I/O,
no clock of its own, no network, no model. It is the component that has to stay
predictable when everything above it is not.

Two rules shape it:

- **Verdicts are all-or-nothing.** A single blocking finding rejects the whole
  proposal. Partial application produces a state that is harder to reason about
  and harder to roll back. Filtering a *profile* down to what a machine
  supports happens above the kernel, before a proposal exists.
- **It fails closed.** Missing thermal telemetry is not "probably fine"; it is
  a blocking finding for any control whose policy depends on temperature.

The control registry (`safety/controls.ts`) is frozen at module load and has no
registration function. A control that is not in that table cannot be proposed,
validated or applied — so neither a config file nor a model response can invent
one. Prohibited controls are present *on purpose*, so a request naming one is
refused with an explanation instead of an unhelpful "unknown".

## Policy narrowing

`BASE_POLICY` is compiled in and frozen. Configuration and Vesper reach it only
through `narrowPolicy`, which is constructed so the result is always a subset:
ranges shrink, enums intersect, requirements can be added, thermal ceilings can
only come down, cooldowns and limits only get stricter, and observation-only is
a one-way switch.

There is no code path that turns the safety layer off. Refusing a request is
always representable; disabling the checks is not. The config schema encodes
the one-way switches as literals (`allowed` accepts only `false`), so a config
asking to widen the policy fails to *parse* — and the user is told why, rather
than having it silently ignored.

## Authority

`RequestOrigin` is `internal | user | vesper`. It is recorded for audit and
used by policy that *restricts* — only a `user`-origin request may carry a
human confirmation. No origin ever widens what the kernel permits.

There is deliberately no field on any type in `domain/optimization.ts` by which
a caller could assert privilege. Defence in depth: the schema rejects unknown
fields at the boundary, and `safety/guards.ts` additionally scans for
authority-claiming field names anywhere in a payload, so a bug upstream cannot
become a bypass.

## Where the honesty lives in the type system

- `Reading.value: number | null` with `status` — unknown cannot be zero.
- `CapabilityRecord.state` — `available` requires a successful probe.
- `Fidelity` on every artifact, combined by minimum.
- `ControlDescriptor.reversibility` — irreversible controls cannot be applied
  automatically.
- `ControlDescriptor.evidenceLevel` — `contested` controls are never
  auto-proposed, because plenty of widely repeated PC tuning advice has no
  measured benefit and shipping it as automatic behaviour would make NEXUS the
  cargo-cult product it is meant not to be.
