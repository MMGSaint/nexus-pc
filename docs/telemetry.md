# Telemetry

## The model

A `Reading` carries a metric, a value, a unit, a timestamp, its source, a
fidelity, a status and a confidence. The status and the value are locked
together: `status === 'ok'` if and only if `value !== null`. Construction goes
through `reading()` or `unknownReading()`, so a reading that claims to be fine
while carrying no number cannot be built.

Statuses: `ok`, `unavailable` (the interface exists but produced nothing),
`stale` (older than its freshness budget), `invalid` (a value arrived and was
rejected), `unsupported` (nothing on this machine can produce it).

## Validation

Every reading is range-checked before it enters the pipeline
(`telemetry/validation.ts`). A rejected reading becomes `invalid` with
`value: null` — never a zero. The bounds are generous; they exist to catch
broken plumbing, not to second-guess a real machine.

Two of them are there for specific, documented reasons:

- **CPU utilisation is bounded at 200%, not 100%.** Windows' `% Processor
  Utility` normalises by frequency, so a boosting CPU doing more work than its
  nominal capacity legitimately reads above 100%. Clamping would destroy
  exactly the signal the counter exists to carry.
- **CPU clock is bounded at 200–7500 MHz.** The frequency counter derives from
  the APERF/MPERF MSRs, which have been observed to return absurd values on
  Ryzen after a suspend/resume cycle. Bounding turns that corruption into an
  explicit `invalid` rather than a fabricated clock.

Cross-validation catches sources that disagree: used VRAM above total VRAM
demotes *both* readings rather than picking a winner.

## Sources

| Source | Platform | Metrics | Status |
|---|---|---|---|
| `nexus.self` | any | own CPU and RSS | tested |
| `os.memory` | any | system memory | tested |
| `windows.perfcounters` | Windows | CPU utilisation and clock, GPU utilisation, VRAM in use | hardware dependent |
| `linux.procfs` | Linux | CPU utilisation, CPU/GPU temperature via hwmon | tested on Linux |
| `mock.simulated` | any | a full simulated set | mocked |
| `sensor.bridge` | any | temperatures, power, fan, clocks | unavailable until a helper is installed |

NEXUS measures itself. It is part of the workload it is optimising, and an
optimizer that spends 8% of a core watching an idle machine has already lost
more than most of its changes could win back.

### Why Windows telemetry uses CIM classes rather than `Get-Counter`

Performance counter *paths* are localised — the English path fails on a German
or Japanese Windows. The formatted CIM classes
(`Win32_PerfFormattedData_*`) use locale-independent property names and return
a cooked value without the two-sample dance a raw PDH query needs.

`% Processor Utility` is preferred over `% Processor Time`. The latter measures
the fraction of time the CPU was non-idle and saturates at 100%, so it cannot
tell a 9950X pinned at 3 GHz from the same chip pinned at 5.7 GHz. When Utility
is unavailable NEXUS falls back to Time and *says so in the reading's note*.

### Why there is a persistent PowerShell host

Spawning `powershell.exe` costs roughly 200–700 ms. Paying that every few
seconds would make NEXUS a net negative on its own terms. So the host is
started once and driven over stdin/stdout with a line protocol, with bounded
restarts on failure (`core/persistent-shell.ts`).

## The sensor bridge

**There is no in-box Windows interface for CPU die temperature, GPU
temperature, hotspot temperature, fan speed or board power.** Those values come
from paths that need a ring-0 driver or a vendor library:

- CPU package temperature, per-core clocks, package power: a ring-0 helper such
  as LibreHardwareMonitorLib, or a running HWiNFO instance. All require
  Administrator.
- AMD GPU temperature, hotspot, fan RPM, board power, clocks: AMD's ADLX
  library, which ships *inside the AMD display driver* and has no command-line,
  WMI or IPC surface — it must be reached from native code.

NEXUS embeds none of them. Instead it defines a bridge: an optional,
separately installed helper writes a small JSON document into the NEXUS runtime
directory, and NEXUS reads it.

```jsonc
// %LOCALAPPDATA%\NEXUS\runtime\sensors.json
{
  "version": 1,
  "producer": "my-sensor-helper",
  "producerVersion": "1.0.0",
  "capturedAtMs": 1737000000000,
  "readings": [
    { "metric": "cpu.temperature", "value": 62.5 },
    { "metric": "gpu.hotspot",     "value": 84.0 },
    { "metric": "gpu.fan.rpm",     "value": 1450 }
  ]
}
```

Rules the bridge is held to:

- Only metrics on the allowed list are accepted. Anything else is discarded,
  not invented.
- The document must be fresh (15 s by default) or every metric reports `stale`.
- Values still pass plausibility validation like any other reading.
- An unknown field rejects the whole document.

**Trust boundary.** The document must live inside the NEXUS home, which is a
per-user directory created with restrictive permissions. Anything able to write
there already runs as the user. This is stated rather than glossed over: the
bridge is not a security boundary, it is an integration point.

**Consequence.** Until a bridge exists, `cpu.telemetry.temperature` and the GPU
thermal capabilities are `unavailable`, and every control with a thermal
precondition is refused with `THERMAL_UNVERIFIABLE`. That is the fail-closed
behaviour working as intended, not a bug — NEXUS will not adjust a boost mode
on a machine whose temperature it cannot read.

## Adaptive sampling

| Mode | Default interval | Entered when |
|---|---|---|
| `low_activity` | 30 s | utilisation below 12% for 2 consecutive samples |
| `active_workload` | 5 s | utilisation at or above 25% for 2 consecutive samples |
| `optimization` | 1 s | a bounded measurement window, explicitly requested |
| `suspended` | — | sampling stopped |

Separate enter and exit thresholds plus a dwell requirement mean a single spike
does not flip the machine into fast sampling and a brief lull does not drop it
out mid-workload. The `optimization` window is always bounded: high-resolution
sampling is never left on by accident.

If NEXUS's own CPU use exceeds its budget (2% of one core by default) it
lengthens its interval and logs the fact. Self-CPU is only estimated over
intervals of at least 2 seconds; below that, scheduler jitter dominates and the
figure would be meaningless.
