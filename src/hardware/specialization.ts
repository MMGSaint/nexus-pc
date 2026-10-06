/**
 * Machine-specific specialization.
 *
 * NEXUS keeps the safety kernel generic, but the optimization strategy does not
 * have to pretend every machine is the same. This module describes the primary
 * target profile used while this repository is private.
 *
 * The target specialization is advisory strategy, not authority: it may cause
 * NEXUS to refuse an automatic generic recommendation, but every explicit user
 * request still goes through the normal safety kernel.
 */

import type { HardwareInventory } from './domain/hardware.js';
import type { ProfileDocument } from './domain/profile.js';

export interface TargetSpecialization {
  readonly id: string;
  readonly label: string;
  readonly matched: boolean;
  readonly exactHardwareMatch: boolean;
  readonly x3dSchedulingSensitive: boolean;
  readonly autoGamingControlStrategy: 'measure-before-global-parking';
  readonly optimizationPriority: readonly string[];
  readonly deferredControls: readonly string[];
  readonly reason: string;
}

export const PRIMARY_TARGET = Object.freeze({
  id: 'primary-9950x3d-7900xt-96gb',
  label: 'Primary target — Ryzen 9 9950X3D / RX 7900 XT / 96 GB',
  cpuNeedle: '9950X3D',
  gpuNeedle: 'RX 7900 XT',
  installedMemoryBytes: 96 * 1024 ** 3,
});

const DEFERRED_X3D_CONTROLS = Object.freeze([
  'power.processor.core_parking_min',
  'power.processor.min_state',
]);

const OPTIMIZATION_PRIORITY = Object.freeze([
  'native-windows-probe',
  'sensor-bridge',
  'frame-time-measurement',
  'stability-oracle',
  'ccd-aware-scheduling',
  'epp-and-boost',
  'machine-specific-ab-tuning',
  'gpu-contention-coordination',
]);

export function specializeTarget(inventory: HardwareInventory | null): TargetSpecialization {
  if (!inventory) {
    return {
      id: 'unknown',
      label: 'Target not yet discovered',
      matched: false,
      exactHardwareMatch: false,
      x3dSchedulingSensitive: false,
      autoGamingControlStrategy: 'measure-before-global-parking',
      optimizationPriority: OPTIMIZATION_PRIORITY,
      deferredControls: DEFERRED_X3D_CONTROLS,
      reason: 'No hardware inventory is available yet.',
    };
  }

  const cpu = inventory.cpu.model?.toUpperCase() ?? '';
  const gpu = inventory.gpus[0]?.model?.toUpperCase() ?? '';
  const cpuMatch = cpu.includes(PRIMARY_TARGET.cpuNeedle);
  const gpuMatch = gpu.includes(PRIMARY_TARGET.gpuNeedle);
  const ramMatch = inventory.memory.installedBytes === PRIMARY_TARGET.installedMemoryBytes;
  const exactHardwareMatch = cpuMatch && gpuMatch && ramMatch;

  if (exactHardwareMatch) {
    return {
      id: PRIMARY_TARGET.id,
      label: PRIMARY_TARGET.label,
      matched: true,
      exactHardwareMatch: true,
      x3dSchedulingSensitive: true,
      autoGamingControlStrategy: 'measure-before-global-parking',
      optimizationPriority: OPTIMIZATION_PRIORITY,
      deferredControls: DEFERRED_X3D_CONTROLS,
      reason:
        'This repository is being specialized for the primary X3D target. Global core-parking and processor-floor changes stay out of automatic gaming recommendations until sensors, frame-time measurement, and CCD-aware scheduling are validated.',
    };
  }

  if (cpuMatch) {
    return {
      id: 'x3d-9950x3d',
      label: 'Ryzen 9 9950X3D family',
      matched: true,
      exactHardwareMatch: false,
      x3dSchedulingSensitive: true,
      autoGamingControlStrategy: 'measure-before-global-parking',
      optimizationPriority: OPTIMIZATION_PRIORITY,
      deferredControls: DEFERRED_X3D_CONTROLS,
      reason:
        'The CPU is a Ryzen 9 9950X3D, so generic whole-package core-parking recommendations are deferred until topology-aware measurement is available.',
    };
  }

  return {
    id: 'generic',
    label: 'Generic machine',
    matched: false,
    exactHardwareMatch: false,
    x3dSchedulingSensitive: false,
    autoGamingControlStrategy: 'measure-before-global-parking',
    optimizationPriority: OPTIMIZATION_PRIORITY,
    deferredControls: [],
    reason: 'The machine does not match the private primary-target specialization.',
  };
}

/**
 * Automatic recommendation guard. This deliberately only guards generic
 * automatic recommendations; an explicit profile selection remains subject to
 * the normal safety kernel and user confirmation rules.
 */
export function automaticProfileGuard(
  profile: ProfileDocument,
  specialization: TargetSpecialization,
): string | null {
  if (!specialization.x3dSchedulingSensitive) return null;

  const deferred = profile.settings
    .map((setting) => setting.control)
    .filter((control) => specialization.deferredControls.includes(control));

  if (deferred.length === 0) return null;

  return (
    `Target specialization "${specialization.id}" defers automatic control of ${deferred.join(
      ', ',
    )}. Validate X3D CCD topology, live sensors, and frame-time impact first; use an explicit profile only when you intend to test those controls.`
  );
}
