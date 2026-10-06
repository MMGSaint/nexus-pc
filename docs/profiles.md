# Profiles

A profile is a **complete, explicit** list of the controls it changes. There is
no "and some tuning" clause: if a setting is not in `settings`, applying the
profile does not change it. That is what makes "NEXUS never silently makes
undocumented changes" checkable rather than aspirational.

```
nexus profiles              # list them
nexus profiles show gaming  # every setting, with the reason for each
```

## Built-in profiles

| Id | Targets | Changes |
|---|---|---|
| `observation` | everything | Nothing. The starting profile, and the fallback when degraded. |
| `efficiency` | idle, desktop | processor floor to 5%, efficient boost |
| `balanced` | desktop, development | floor 5%, ceiling 100%, aggressive boost |
| `gaming` | gaming, GPU-bound | floor 20%, ceiling 100%, all cores unparked, aggressive boost |
| `streaming` | streaming | floor 30%, ceiling 100%, all cores unparked |
| `workstation` | development, AI, CPU-bound, mixed | all cores unparked, ceiling 100%, aggressive boost |

Every setting carries a rationale, shown verbatim by `nexus profiles show`.

## Per-application profiles

Profiles may optionally declare `applicationIds`. When NEXUS observes a matching
executable name, and that profile also targets the observed workload, NEXUS prefers
the application-specific profile over the generic workload profile. The match is a
process-name heuristic: it does not prove that the game is the foreground window
and it never bypasses the confidence, capability, thermal, confirmation, or
rollback checks.

Recognized ids currently include `squad`, `where-winds-meet`, `vrchat`,
`red-dead-redemption-2`, `cyberpunk-2077`, `helldivers-2`, and `elden-ring`.
An id being recognized does not mean NEXUS has a vendor-approved "correct" setting
for that title; the settings in a profile are still explicit configuration that
must be validated on the user's machine.

Example:

```jsonc
{
  "id": "squad-low-latency",
  "name": "Squad — my validated profile",
  "description": "Settings I chose after measuring Squad on this machine",
  "version": 1,
  "author": "user",
  "targets": ["gaming"],
  "applicationIds": ["squad"],
  "settings": [
    {
      "control": "power.processor.min_state",
      "value": 20,
      "rationale": "Validated against my normal Squad workload"
    }
  ],
  "requiresCapabilities": ["power.setting.read", "power.setting.write"]
}
```

### AMD driver boundary

NEXUS does **not** own AMD Adrenalin game profiles or driver settings. It does not
change Adrenalin's per-game presets, Radeon tuning, clocks, voltage, fan curves,
or driver installation. Those controls are deliberately outside the NEXUS control
registry. This keeps NEXUS from fighting vendor software or treating a driver-side
change as though it were a NEXUS-controlled optimization.

## What is deliberately absent

No registry "tweaks" of contested value, no service disabling, no memory
"cleaning". Those either have no measured benefit or cannot be measured by
NEXUS, and shipping them as defaults would be exactly the cargo-cult behaviour
this system exists not to be.

Controls with `evidenceLevel: 'contested'` — Game Mode, HAGS, the MMCSS
registry values, disabling processor idle states — remain reachable, but only
by explicit human request, and the kernel refuses them on any internal or
Vesper-origin proposal. A test asserts no built-in profile contains one.

## Validation

Profiles are validated at **load** time, not apply time, against both the
control registry and the effective safety policy. A profile that names a
control that does not exist, or is prohibited, or is read-only, or sets a value
outside the policy range, or sets the same control twice, is rejected with a
reason and never sits in the list waiting to fail later.

User profiles live in `<NEXUS home>/profiles/*.json` and are parsed with the
same strict schema as everything else — an unknown field rejects the file.

```jsonc
{
  "id": "my-gaming",
  "name": "My gaming profile",
  "description": "What I actually want when I play",
  "version": 1,
  "author": "user",
  "targets": ["gaming"],
  "settings": [
    {
      "control": "power.processor.min_state",
      "value": 25,
      "rationale": "I prefer a slightly higher floor than the built-in profile"
    }
  ],
  "requiresCapabilities": ["power.setting.read", "power.setting.write"]
}
```

A user profile with the id of a built-in one replaces it.

## Applicability

Separately from validity, `applicability` answers "can this profile do anything
on *this* machine right now?" — splitting settings into supported and
unsupported based on live capability state. That filtering happens above the
safety kernel, before a proposal exists, which is why the kernel itself can
stay strictly all-or-nothing.

## Private X3D specialization

The private primary target is a Ryzen 9 9950X3D. Because that processor has a cache-sensitive gaming topology, NEXUS does not automatically select a profile that changes whole-package core parking or the processor floor on that target until the native topology probe, live sensor bridge, frame-time measurement, stability oracle, and CCD-aware scheduling work are validated. This prevents a generic recipe from becoming the target's permanent truth.
