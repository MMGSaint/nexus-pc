# Dependencies and downloads

## What NEXUS itself needs

**Node.js 20.11 or later.** That is the entire runtime requirement.

NEXUS has **zero runtime npm dependencies**. `package.json` has an empty
`dependencies` block, and that is deliberate: every byte crossing a trust
boundary is parsed by code in this repository. Development dependencies
(TypeScript, vitest, eslint) are not shipped and are not needed to run it.

Everything NEXUS uses on Windows is in the box: PowerShell, CIM/WMI and
`powercfg.exe`. **No AMD software, no monitoring tool and no driver is required
for NEXUS to start, discover hardware, classify workloads, capture a baseline,
or manage power-plan settings.**

## What is required for temperature, power and fan telemetry

Nothing in Windows exposes CPU die temperature, GPU temperature, hotspot
temperature, fan speed or board power to an ordinary process. Those need one of
the paths below, none of which NEXUS embeds.

### AMD GPU (RX 7900 XT)

**AMD ADLX** is AMD's current first-party telemetry and tuning API. It provides
exactly what is missing: GPU usage, dedicated VRAM, edge temperature,
hotspot/junction temperature, fan RPM and duty, GPU power, total board power,
and core and memory clocks.

What matters for planning:

- ADLX ships **inside the AMD display driver** (`amdadlx64.dll`). The SDK on
  GitHub is headers, docs and samples only — there is no redistributable DLL
  and no import library.
- There is **no command-line tool, no WMI provider and no IPC service**. It
  must be reached from native code. `amd-smi` is Linux/ROCm only.
- Reaching it from Node means either an N-API addon compiled against the ADLX
  headers, or a small helper `.exe` that prints JSON.
- Every metric is gated by a matching `IsSupported…` call, which must be
  honoured — support is per-ASIC.
- The older ADL/ADL2 (`atiadlxx.dll`) is superseded but not dead; its
  Overdrive8 PMLog shared-memory path exposes a richer sensor set (per-rail
  power, memory temperature, throttle reasons) and is what
  LibreHardwareMonitor uses.

**The user's machine already has the AMD driver**, so ADLX is present. What
does not exist yet is a NEXUS helper that talks to it.

### CPU (Ryzen 9 9950X)

CPU die temperature, per-core clocks and package power require reading AMD
SMN/MSR registers through a ring-0 driver. Options, with their costs:

| Option | Requires | Licensing note |
|---|---|---|
| LibreHardwareMonitorLib | Its driver (PawnIO on current versions); Administrator | MPL 2.0. Permits shipping a closed product provided changes to LHM's own files are published. |
| HWiNFO64 shared memory | HWiNFO running elevated | Shared Memory needs an HWiNFO Pro subscription, and its terms are restrictive enough to likely disqualify commercial use. Read them first. |
| AMD Ryzen Master SDK | `AMDRyzenMasterDriver.sys`; Administrator | Restrictive EULA on redistribution. Zen 5 support is not guaranteed and must be verified on the target. |

**Do not use WinRing0.** The driver historically used by many monitoring tools
is CVE-2020-14979 and is now detected and quarantined by Microsoft Defender as
a bring-your-own-vulnerable-driver privilege-escalation vector.

**`MSAcpi_ThermalZoneTemperature` is not a substitute.** On most consumer AM5
boards the class has no instances at all, and where it exists it reports a
board thermal zone near the socket — typically 20–40 °C below Tctl and barely
responsive to load. NEXUS does not read it.

### How NEXUS consumes any of these

Through the **sensor bridge** (see [telemetry.md](telemetry.md)): an optional
helper writes a small JSON document into the NEXUS runtime directory. NEXUS
validates, ages and range-checks it like any other source.

This keeps the licensing and driver decisions the user's, keeps a ring-0 driver
out of the NEXUS process, and means NEXUS is fully functional without one — it
simply reports those capabilities as unavailable and refuses temperature-gated
controls.

## What NEXUS will not install

NEXUS installs nothing and downloads nothing. It will not fetch a driver, a
monitoring tool or a vendor SDK. If a capability needs software the user does
not have, NEXUS reports the capability as unavailable and explains why in
`nexus doctor`.

## Elevation

| Operation | Elevation |
|---|---|
| Hardware discovery, CIM inventory | none |
| CPU/GPU utilisation, memory, disk inventory | none |
| Reading power schemes and settings | none |
| **Writing** power scheme settings | typically Administrator |
| NVMe temperature via storage reliability counters | Administrator |
| Any ring-0 sensor helper | Administrator |
| Registering the logon task | none (`-Elevated` needs Administrator) |

NEXUS runs unelevated by default and reports what it cannot do, rather than
asking for privileges it may not need.
