# NEXUS third-party integration ledger

NEXUS deliberately **uses mature external components instead of recreating difficult platform plumbing**. This file records what is integrated, what code NEXUS actually owns, and where license obligations live.

## LibreHardwareMonitor

NEXUS consumes the local LibreHardwareMonitor web server's `/data.json` endpoint for CPU/GPU/storage sensor data. NEXUS does not copy its library or driver code.

License: MPL-2.0. LibreHardwareMonitor also publishes third-party notices for portions under other terms. When redistributing LHM itself, keep its license and third-party notice files with that component.

## PresentMon

NEXUS invokes the upstream PresentMon executable and parses its CSV output. NEXUS does not reproduce PresentMon's ETW collection implementation.

The integration deliberately uses the stable command-line surface: process id/name targeting, timed capture, CSV output and v2 metrics. The capture binary should be installed separately and its own notices retained.

## Design rule

Runtime dependencies are preferred when their license and maintenance story are better than local reimplementation. For platform-heavy tools, a subprocess/HTTP/IPC bridge is preferred: the mature component remains independently updateable and NEXUS keeps the smaller trust boundary.

Do not vendor third-party source into this repository without first recording:
1. source repository and commit/tag,
2. applicable license,
3. required attribution/notice files,
4. exact files copied or modified.

MIT components may be adapted with copyright/license preservation. MPL components require attention to the file-level copyleft obligations when their source is copied into a larger work.

## Current borrowed-build principle

> Borrow the plumbing. Keep the authority.

PresentMon may observe frames; LibreHardwareMonitor may observe sensors; an inference engine may produce text. None of them may bypass the NEXUS safety kernel, checkpoint layer, fidelity model or audit trail.
