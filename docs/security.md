# Security model

## Threat model

NEXUS runs as the user, on the user's machine, and changes settings that affect
that machine's power and thermal behaviour. The threats worth defending against
are:

1. **A confused or hostile orchestrator.** Vesper, or something impersonating
   it, tries to make NEXUS do something unsafe.
2. **Model output treated as authority.** A recommendation that reads as
   confident is still just a recommendation.
3. **Untrusted configuration.** A config file that tries to widen what NEXUS is
   allowed to do.
4. **Broken or hostile sensors.** Readings that would satisfy a safety gate
   that should have failed.
5. **A mock mistaken for reality.** A simulation reporting success that a human
   or Vesper acts on.

Explicitly *not* in the model: an attacker who already has code execution as
this user. They can read the token, write the sensor bridge file and edit the
config. NEXUS's per-user files are not a boundary against that, and this
document does not pretend otherwise.

## The properties, and what enforces each

| Property | Mechanism | Test |
|---|---|---|
| Model/Vesper input cannot bypass hardware safety | Kernel is a pure function; prohibited controls refused by name under every origin; contested evidence refused for non-user origins; forged confirmations rejected | `tests/security` |
| Malformed telemetry cannot trigger unsafe behaviour | Plausibility bounds; thermal gates fail closed when a temperature cannot be read; rejected readings become `null`, never `0` | `tests/security`, `tests/telemetry` |
| Fake capabilities cannot become enabled capabilities | Capabilities start `unverified`; only a successful probe promotes one; provider trust clamps reported fidelity | `tests/security` |
| A mock cannot impersonate live hardware control | Fidelity lattice takes the minimum; `sealSource` and the capability registry clamp; outcomes carry the weakest actuator fidelity | `tests/security`, `tests/vesper` |
| Optimizer output cannot grant itself authority | No authority field exists on any type; unknown fields rejected at the boundary; `scanForAuthorityClaims` as defence in depth; controls cannot be invented | `tests/security` |
| Rollback cannot cross its scope | A restore may only write controls its checkpoint captured; ids are pattern-validated | `tests/security`, `tests/checkpoint` |
| Startup/recovery cannot bypass safety | Writes refused in every run state except `ready`/`degraded`; unresolved recovery forces observation-only | `tests/security` |
| Configuration cannot disable safety | `narrowPolicy` can only shrink; one-way switches are literals in the schema so widening fails to parse | `tests/safety`, `tests/security` |

## Process execution

Everything NEXUS learns from the OS that is not available through a Node API
goes through `core/exec.ts`:

- **No shell.** Argument vectors only — there is no quoting to get wrong.
- **An allowlist.** Only specific executables can be launched, matched by
  basename with both path separators handled explicitly so the check does not
  behave differently per platform. `wmic` is deliberately absent.
- **Bounds.** Every call has a timeout and an output cap; the child is killed
  when either is exceeded.
- **A minimal environment.** Children inherit only the variables they need.
- **Dynamic values never reach script text.** They are passed through the
  child's environment and read there, so a value containing quotes, semicolons
  or newlines is inert. This is tested with a hostile value.

## Network posture

NEXUS binds no network socket. Local IPC is a named pipe or a unix socket. A
lint rule rejects a port-based `listen`; a test walks the source tree to assert
it. No inbound LAN listener, no internet listener, no USB transport.

## Secrets

Two mechanisms, because either alone is insufficient:

- **Key-based:** fields whose name suggests a credential are masked before
  anything is written.
- **Value-based:** literal secrets registered at runtime (the Vesper token) are
  scrubbed wherever they appear — including inside an error message that quoted
  one, and including the audit record's `message`, not only its `data`.

## Audit integrity

Append-only JSONL, each record carrying the hash of the one before it, chained
across segment rotations. `nexus audit verify` reports the first point where
the chain breaks. Detection, not prevention: someone with write access can
delete the file. They cannot alter it without it showing.

## What a future campaign should attack

This is targeted coverage, not a full red-team campaign. The pre-1.0 NEXUS +
Vesper campaign should go after: the sensor bridge as a thermal-gate bypass;
race conditions between the instance lock and recovery; the persistent
PowerShell host protocol; audit-log pruning as a way to destroy evidence; and
policy narrowing under a deliberately adversarial config.
