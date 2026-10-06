# WARDEN: adaptive gaming and VR intelligence

WARDEN is the policy layer for game sessions. It keeps four facts separate:

- **Desired state**: what the profile says this game should use.
- **Observed state**: what the machine actually reports.
- **Evidence**: where that observation came from and whether it is live.
- **Apply timing**: whether a change can happen now, at relaunch, or at the next login.

That separation is deliberate. A driver update can invalidate a previously-good Radeon configuration; WARDEN should detect the drift, stage the repair, and never claim the repair happened until a live adapter confirms it.

## Mature components

PresentMon is the preferred frame/present measurement source because it is designed for high-level graphics performance measurement and exposes CPU/GPU/display timing. It is MIT licensed.

OpenXR is the preferred VR architecture reference: its loader discovers active runtimes and its layered model provides a clean place for instrumentation.

LibreHardwareMonitor is a strong sensor candidate, but it is MPL-2.0, so NEXUS keeps it at an external bridge boundary instead of copying its internals.

NAudio is MIT and is a candidate for an optional Windows audio-session bridge.

AMD ADLX is the preferred official AMD boundary because AMD documents performance monitoring, 3D graphics/GPU tuning, event notifications, and driver compatibility. ADLX is distributed under its own SDK license agreement, so it is an external dependency, not pasted source.

