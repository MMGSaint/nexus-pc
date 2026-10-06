/**
 * Deterministic primary-GPU selection.
 *
 * Integrated graphics can appear before a discrete GPU in Windows enumeration
 * (notably on X3D desktops with a Radeon iGPU). Never assume array index 0 is
 * the graphics adapter that owns game rendering. Prefer a GPU with known
 * dedicated VRAM, then greater VRAM, then a stable lower index.
 */

import type { GpuInventory, HardwareInventory } from '../domain/hardware.js';

export function selectPrimaryGpu(gpus: readonly GpuInventory[]): GpuInventory | null {
  if (gpus.length === 0) return null;
  const ranked = [...gpus].sort((a, b) => gpuScore(b) - gpuScore(a) || a.index - b.index);
  return ranked[0] ?? null;
}

function gpuScore(gpu: GpuInventory): number {
  let score = 0;
  if (gpu.vramBytes !== null && gpu.vramBytes > 0) score += 100;
  if (/discrete|dedicated/i.test(gpu.model ?? '')) score += 5;
  const vramGiB = gpu.vramBytes === null ? 0 : gpu.vramBytes / 1024 ** 3;
  score += Math.min(64, Math.max(0, vramGiB));
  if (/radeon graphics$/i.test(gpu.model ?? '') && vramGiB === 0) score -= 20;
  return score;
}

export function selectPrimaryGpuFromInventory(inventory: HardwareInventory): GpuInventory | null {
  return selectPrimaryGpu(inventory.gpus);
}
