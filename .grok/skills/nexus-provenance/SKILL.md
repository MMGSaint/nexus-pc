---
name: nexus-provenance
description: Track third-party dependencies, licenses, versions or commits, attribution, copied or derived material, and supply-chain risk for NEXUS. Use whenever NEXUS evaluates, adopts, vendors, copies from, or derives architecture or code from an external project.
metadata:
  author: Yeager
  short-description: NEXUS dependency provenance
  user-invocable: "true"
  pack: nexus-builder-pack
---

# NEXUS Provenance

Reuse effort aggressively. Reuse code deliberately.
The project currently has an empty runtime `dependencies` block. That is a security decision, not an oversight.

## For every candidate record
- project / repository
- URL
- version, release, or commit
- authoritative license file, not a badge
- direct dependency vs reference
- what NEXUS would use
- copied code? yes/no
- derived design? yes/no
- attribution / notice requirements
- maintenance status
- known security issues
- runtime / build footprint
- integration strategy (in-process, helper exe, sensor bridge, study-only)

## Constraints specific to this repo
Do not copy GitHub code into NEXUS without this record.
A ring-0 helper stays outside the NEXUS process.
MPL-2.0 (LibreHardwareMonitor) permits use with file-level copyleft on modified LHM files — evaluate before shipping.
AMD Ryzen Master SDK redistribution is EULA-restricted.
Never treat a successful compile of an SDK sample as an approved integration.
