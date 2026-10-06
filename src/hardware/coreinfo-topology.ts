/**
 * Coreinfo cache-topology bridge.
 *
 * Microsoft Sysinternals Coreinfo is the mature topology probe; NEXUS only
 * parses its text map. It is an optional external tool, never a control
 * authority. On an X3D part, the L3 cache with the largest capacity identifies
 * the logical processors belonging to the V-Cache CCD. NEXUS treats that as
 * evidence, not a hardcoded core-number assumption.
 */

import type { CommandRunner } from '../core/exec.js';
import { runPowerShell } from '../core/exec.js';
import { nexusError, type NexusError } from '../core/errors.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';

export interface CacheDomain {
  readonly level: number;
  readonly sizeBytes: number | null;
  readonly logicalProcessors: readonly number[];
  readonly maskText: string;
}

export interface X3dTopology {
  readonly available: boolean;
  readonly logicalProcessorCount: number;
  readonly l3Domains: readonly CacheDomain[];
  readonly vCacheDomain: CacheDomain | null;
  readonly standardCacheDomain: CacheDomain | null;
  readonly detail: string;
}

const COREINFO_SCRIPT = String.raw`
$coreInfo = Get-Command coreinfo.exe -ErrorAction SilentlyContinue
if (-not $coreInfo) { throw 'Coreinfo.exe is not installed or is not on PATH.' }
& $coreInfo.Source -l
`;

function parseSizeBytes(value: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(KB|MB|GB)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2].toUpperCase();
  const mult = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : unit === 'GB' ? 1024 ** 3 : 0;
  return mult === 0 ? null : Math.round(n * mult);
}

/** Parse the asterisk/dash logical-processor map Coreinfo prints before each cache. */
export function parseCoreinfoCacheOutput(stdout: string): X3dTopology {
  const l3Domains: CacheDomain[] = [];
  let logicalProcessorCount = 0;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, '');
    const cache = /^(?<mask>[*-]+)\s+(?<kind>.+?Cache)\s+\d+,\s+Level\s+(?<level>\d+),\s+(?<size>[^,]+),/i.exec(line);
    if (!cache?.groups?.mask || !cache.groups.level || !cache.groups.size || !cache.groups.kind) continue;
    const maskText = cache.groups.mask;
    logicalProcessorCount = Math.max(logicalProcessorCount, maskText.length);
    const level = Number(cache.groups.level);
    if (level !== 3 || !/Unified Cache/i.test(cache.groups.kind)) continue;

    const logicalProcessors = [...maskText]
      .map((ch, index) => (ch === '*' ? index : -1))
      .filter((index) => index >= 0);
    l3Domains.push({
      level,
      sizeBytes: parseSizeBytes(cache.groups.size),
      logicalProcessors,
      maskText,
    });
  }

  // Some Coreinfo fixtures/versions expose one short mask per cache domain
  // rather than one full-width logical-processor map. Preserve the strongest
  // observed count, and fall back to the combined L3 mask widths for that form.
  const l3MaskWidth = l3Domains.reduce((sum, domain) => sum + domain.maskText.length, 0);
  logicalProcessorCount = Math.max(logicalProcessorCount, l3MaskWidth);
  const sized = [...l3Domains].filter((d) => d.sizeBytes !== null).sort((a,b) => (b.sizeBytes! - a.sizeBytes!) || (b.logicalProcessors.length - a.logicalProcessors.length));
  const vCacheDomain = sized.length >= 2 && (sized[0]!.sizeBytes! / Math.max(1, sized[1]!.sizeBytes!)) >= 1.5 ? sized[0]! : null;
  const standardCacheDomain = vCacheDomain ? sized[1] ?? null : null;

  return {
    available: l3Domains.length > 0,
    logicalProcessorCount,
    l3Domains,
    vCacheDomain,
    standardCacheDomain,
    detail:
      vCacheDomain
        ? `Coreinfo reports an L3 cache domain at ${vCacheDomain.sizeBytes! / 1024 ** 2} MiB with ${vCacheDomain.logicalProcessors.length} logical processor(s); this is treated as the likely V-Cache domain.`
        : l3Domains.length > 0
          ? 'Coreinfo reported L3 cache topology, but it did not contain a distinct larger L3 domain that can be safely identified as V-Cache.'
          : 'Coreinfo did not yield a usable L3 cache map.',
  };
}

export async function probeCoreinfoTopology(runner: CommandRunner): Promise<Result<X3dTopology, NexusError>> {
  const result = await runPowerShell(runner, COREINFO_SCRIPT, { timeoutMs: 10_000 });
  if (!result.ok) return err(result.error);
  if (result.value.code !== 0) {
    return err(nexusError('E_UNAVAILABLE', `Coreinfo topology probe failed: ${result.value.stderr.trim() || 'unknown error'}`));
  }
  return ok(parseCoreinfoCacheOutput(result.value.stdout));
}
