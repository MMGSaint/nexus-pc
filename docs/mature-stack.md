# NEXUS mature-component stack

The private NEXUS build intentionally composes mature projects where platform plumbing is already solved.

| Need | Component | NEXUS integration | Authority |
|---|---|---|---|
| Hardware sensors | LibreHardwareMonitor | local JSON web endpoint | NEXUS selects/validates readings |
| Frame timing | PresentMon | CLI CSV capture | NEXUS interprets evidence |
| CPU/cache topology | Microsoft Sysinternals Coreinfo | optional CLI topology probe | NEXUS interprets cache domains |
| Process topology ideas | ProcGovernor (CC0) | design reference for affinity/CPU-set concepts | NEXUS safety kernel |
| Audio UX reference | EarTrumpet (MIT with excluded entities noted in upstream license) | architecture/UX reference; no source vendoring in this pass | Vesper permission layer |

## Private-machine policy

Third-party tools are replaceable adapters, not hidden authorities. A missing external component yields an unavailable/unverified capability; NEXUS never pretends a missing sensor or timing source is zero.

Coreinfo is optional and must be installed separately from Microsoft's Sysinternals distribution; NEXUS does not redistribute it. It is used only for observation at this stage.

PresentMon is the primary frame evidence source. Its current release exposes CPU/GPU/display timing metrics and CSV capture; NEXUS consumes the mature command-line surface rather than reproducing ETW collection.

LibreHardwareMonitor is the sensor source for the initial bring-up. Its local web server is preferable to copying hardware-monitoring drivers into NEXUS.

The private build may change or replace any adapter when a better-maintained mature implementation is discovered. The safety kernel, provenance/fidelity model, checkpoints, rollback, and audit trail remain NEXUS-owned.
