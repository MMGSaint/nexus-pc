# Hardware detection

Discovery answers one question: what machine is this? Every field is nullable,
and a partial answer is reported as a partial answer rather than filled in with
plausible defaults.

## Providers

| Provider | Platform | Trust | Notes |
|---|---|---|---|
| `windows.cim` | Windows | `live` | PowerShell + CIM. No extra software required. |
| `linux.procfs` | Linux | `live` | procfs/sysfs. For developing NEXUS, not a Windows substitute. |
| `mock:<fixture>` | any | `mocked` | Fixture-backed. Everything derived from it is labelled `mocked`. |

Providers are tried in registration order; the first that succeeds wins. When
all fail, discovery returns an error listing each failure — never an empty
inventory that could be mistaken for a successful read of a bare machine.

## Windows specifics that matter

**Video memory.** `Win32_VideoController.AdapterRAM` is an unsigned 32-bit byte
count, so any adapter with 4 GiB or more saturates it. On an RX 7900 XT it
would report roughly 4 GiB instead of 20. NEXUS reads
`HardwareInformation.qwMemorySize` from the display adapter's driver key
instead, which is 64-bit and correct. `AdapterRAM` is used only as a fallback
*below* a saturation floor (4 GiB minus 64 MiB, because saturated values are
not always exactly 2³²−1 — 4095 MiB is common), and when it is used the
inventory records `vramSource` and emits a warning that the figure is a lower
bound. When neither source is trustworthy, `vramBytes` is `null`.

**`wmic` is gone.** Microsoft removed it entirely in Windows 11 24H2. NEXUS
never invokes it; it is not on the executable allowlist. All CIM access goes
through `Get-CimInstance`.

**CPU clocks.** `Win32_Processor.MaxClockSpeed` is a static SMBIOS field
captured at boot, not a live measurement, and `CurrentClockSpeed` is worse — it
frequently just mirrors the base clock. NEXUS records `MaxClockSpeed` as
`maxClockMhz` (a firmware nominal figure), never reads `CurrentClockSpeed`, and
takes live clocks from telemetry only.

**Memory, three ways.** These legitimately differ and conflating them makes a
correct reading look like a bug:

- `installedBytes` — sum of `Win32_PhysicalMemory.Capacity`. This is the figure
  a user recognises: 96 GB.
- `totalBytes` — `Win32_ComputerSystem.TotalPhysicalMemory`, what the OS can
  use. Slightly lower, because firmware and hardware reserve some.
- `availableBytes` — from `os.freemem()`, which on Windows is
  `GlobalMemoryStatusEx().ullAvailPhys`: Task Manager's "Available", including
  the reclaimable standby list. `Win32_OperatingSystem.FreePhysicalMemory`
  counts only free and zeroed pages and reads alarmingly low on any machine
  with a warm file cache, so it is a fallback only. The source is recorded in
  `availableSource`.

A discrepancy of more than 10% between installed and usable raises a warning.

**DDR5.** `Win32_PhysicalMemory.MemoryType` enumerates only up to DDR4, so
every DDR5 module reports `0 / Unknown`. NEXUS reads `SMBIOSMemoryType`
instead (34 = DDR5). It also compares `Speed` (the module's rated SPD/EXPO
figure) against `ConfiguredClockSpeed` (what it is actually running at) and
warns when they differ — that usually means EXPO/DOCP is not applied in
firmware, which is a genuinely useful thing to be told.

**Machine identity.** The machine UUID is hashed before storage. NEXUS can
recognise the same machine across sessions without the identifier itself ever
being written to disk or sent to Vesper.

## What discovery does not do

It does not read temperatures, power, fan speeds or clocks. Those are
telemetry, they need interfaces Windows does not expose in-box, and they are
covered in [telemetry.md](telemetry.md).

## Validating on the target machine

```
nexus discover
```

Check that the CPU is identified as a Ryzen 9 9950X with 16 cores and 32
threads, the GPU as a Radeon RX 7900 XT with **20 GiB** of dedicated memory
sourced from `registry:HardwareInformation.qwMemorySize`, and memory as 96 GiB
installed DDR5. If VRAM reads ~4 GiB, the registry read failed and fell back to
`AdapterRAM` — the warning will say so.
