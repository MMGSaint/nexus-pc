# Third-party notices

NEXUS deliberately uses mature external software at narrow boundaries instead of reimplementing specialist subsystems.

## PresentMon — MIT

NEXUS uses an adapter around PresentMon for frame/present telemetry. The upstream project is MIT licensed. Preserve the upstream copyright/license notice for any copied substantial source.

https://github.com/GameTechDev/PresentMon

## OpenXR — Apache-2.0 OR MIT (file-dependent)

NEXUS follows the OpenXR loader/layer architecture for VR discovery and future instrumentation. When copying OpenXR source, retain the exact SPDX/license header from each upstream file.

https://github.com/KhronosGroup/OpenXR-SDK-Source

## LibreHardwareMonitor — MPL-2.0

LibreHardwareMonitor is an excellent sensor source, but its repo is MPL-2.0 and contains third-party components with their own terms. Prefer an external local bridge and do not paste source here without preserving the applicable notices.

https://github.com/LibreHardwareMonitor/LibreHardwareMonitor

## NAudio — MIT

NAudio is a candidate for a tiny Windows audio-session bridge. Its WASAPI package exposes device enumeration and per-session volume/metering. A narrow bridge keeps NEXUS's core native/TypeScript instead of embedding an unnecessary .NET subsystem.

https://github.com/naudio/NAudio

## AMD ADLX — AMD SDK License Agreement

ADLX provides official AMD performance-monitoring and GPU/3D-control APIs, including driver-state synchronization. It is distributed under AMD's SDK license agreement, not a generic permissive OSS license. Treat it as an optional external SDK/helper boundary.

https://github.com/GPUOpen-LibrariesAndSDKs/ADLX
