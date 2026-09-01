# The Vesper interface

Vesper is the user's assistant: it understands intent and orchestrates. NEXUS
is the hardware specialist: it understands the machine and does the work. This
document and `src/vesper/` are the whole of the boundary. The two systems share
no code, no process and no repository.

**NEXUS does not implement Vesper and does not depend on it.** Everything here
works with the interface disabled.

## Transport

A Windows named pipe or a POSIX unix domain socket, addressed by path,
newline-delimited JSON.

**NEXUS never binds a TCP or UDP port.** There is no LAN listener, no internet
listener, and no USB transport. A lint rule rejects a port-based `listen`, and
a security test walks the entire source tree asserting that every `listen` call
passes a path.

```
Windows  \\.\pipe\nexus-<discriminator>
POSIX    <NEXUS home>/runtime/vesper.sock   (mode 0600)
```

The discriminator is derived from the home path, so two NEXUS homes on one
machine do not collide.

## Enabling it

Disabled by default. In `<NEXUS home>/config.json`:

```jsonc
{
  "vesper": {
    "enabled": true,
    "scopes": ["status", "capabilities", "telemetry", "workload", "recommend"]
  }
}
```

```
nexus vesper    # endpoint, contract version, granted scopes, token location
```

## Authentication

A shared secret at `<NEXUS home>/runtime/vesper-token`, mode 0600, generated on
first use. Vesper reads the file and presents the token on every request.
Comparison is constant time.

This is not a substitute for OS access control and is not claimed to be:
anything already running as this user can read the token. Its job is narrower
and still worth doing — it stops an unrelated local process from stumbling onto
the endpoint, and it gives the audit trail something concrete to record.

The token is registered as a secret at load, so it is scrubbed from every log
and audit record — including from error text that quoted it.

## Scopes

**Asking does not confer authority.** Scopes are granted by the user in NEXUS's
configuration, never claimed in a request.

| Method | Scope | Granted by default |
|---|---|---|
| `getStatus` | `status` | yes |
| `getCapabilities` | `capabilities` | yes |
| `getTelemetrySummary` | `telemetry` | yes |
| `getCurrentProfile`, `listProfiles` | `status` | yes |
| `analyzeWorkload` | `workload` | yes |
| `recommend` | `recommend` | yes |
| `getOptimizationResult` | `status` | yes |
| `declareContext` | `context` | **no** |
| `optimize` | `optimize` | **no** |
| `rollback` | `rollback` | **no** |

The three mutating scopes must be added deliberately. A Vesper request with an
ungranted scope is refused with `E_SCOPE` and audited.

## Protocol

```jsonc
// request
{ "v": "1.0.0", "id": "req-1", "method": "getStatus", "token": "…", "params": {} }

// success
{ "v": "1.0.0", "id": "req-1", "ok": true, "fidelity": "live", "result": { … } }

// failure
{ "v": "1.0.0", "id": "req-1", "ok": false, "fidelity": "unavailable",
  "error": { "code": "E_SCOPE", "message": "…" } }
```

Major-version mismatch is refused with `E_UNSUPPORTED`.

## Fidelity is always reported

Every response carries the provenance of the data behind it:

| Value | Meaning |
|---|---|
| `live` | Real measurements from this machine |
| `simulated` | Produced by a model |
| `mocked` | Produced from fixtures |
| `unverified` | NEXUS has not confirmed this is real |
| `unavailable` | Nothing was produced |

**Vesper must never receive a fake success from a mock optimizer.** An outcome
produced through mock actuators arrives at the boundary as `mocked` and leaves
as `mocked`. This is enforced by the fidelity lattice rather than by
convention, and it is tested.

## Context, not commands

`declareContext` is how Vesper says "the user told me they are about to
stream". NEXUS records who said it and when, applies a TTL, and treats it as
**evidence in classification, never as an instruction**.

If the hint agrees with what NEXUS observes, confidence rises — but never to
certainty, because a hint is a claim about intent, not a measurement. If the
hint is not visible in the telemetry at all, `contextConflict` is set and both
readings are reported. NEXUS does not silently adopt the claim, and it does not
silently discard it.

User-intent logic stays in Vesper. NEXUS classifies what it can observe.

## Override model

Vesper may eventually request something NEXUS would not have chosen. The
sequence is:

```
VESPER REQUEST → NEXUS VALIDATES SAFETY → APPLY → MEASURE → RESULT
```

Vesper cannot bypass the safety kernel. A Vesper-origin request:

- is refused for any prohibited control;
- is refused for any control with contested evidence;
- **cannot carry a human confirmation** — a confirmation on a Vesper-origin
  request is a blocking finding (`CONFIRMATION_ORIGIN_INVALID`), because only a
  request originating with the user can carry one;
- passes through exactly the same capability, telemetry, thermal, baseline,
  cooldown and rate checks as anything else.

## Feedback

`getOptimizationResult` returns the structured outcome — what was recommended,
what was observed, and whether the result was a benefit, no measurable benefit,
a regression, or unverified. Vesper may learn from this. NEXUS does not mutate
its own safety policy from it.

## Bounds

Line length 64 KiB · 4 concurrent connections · 120 requests/minute/connection ·
120 s idle timeout · payload depth 8 · payload nodes 512. Requests are
structure-bounded *before* schema parsing, and the schema rejects unknown
fields — so a payload cannot smuggle an extra field for some later layer to
read.
