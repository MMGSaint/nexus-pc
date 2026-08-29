/**
 * Filesystem helpers with the durability properties NEXUS relies on.
 *
 * Every persisted document is written to a temporary file in the same
 * directory and then renamed over the target, so a crash mid-write leaves
 * either the previous document or the new one, never a truncated file.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Result } from './result.js';
import { err, ok } from './result.js';
import type { NexusError } from './errors.js';
import { nexusError, toNexusError } from './errors.js';
import { canonicalJson } from './canonical-json.js';
import type { Issue, Validator } from './validate.js';
import { formatIssues } from './validate.js';

export async function ensureDir(dir: string): Promise<Result<true, NexusError>> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return ok(true);
  } catch (e) {
    return err(toNexusError(e, 'E_IO'));
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic replace. `fsyncData` costs a disk flush; it is used for records whose
 * loss would make recovery unsafe (checkpoints, session state), and skipped for
 * cheap, regenerable documents.
 */
export async function atomicWrite(
  target: string,
  contents: string,
  options: { readonly fsyncData?: boolean; readonly mode?: number } = {},
): Promise<Result<true, NexusError>> {
  const dir = path.dirname(target);
  const dirResult = await ensureDir(dir);
  if (!dirResult.ok) return dirResult;

  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid.toString(36)}.tmp`);
  try {
    const handle = await fs.open(tmp, 'w', options.mode ?? 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      if (options.fsyncData) await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    return ok(true);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return err(toNexusError(e, 'E_IO'));
  }
}

export async function writeJson(
  target: string,
  value: unknown,
  options: { readonly fsyncData?: boolean; readonly mode?: number } = {},
): Promise<Result<true, NexusError>> {
  let serialized: string;
  try {
    serialized = `${canonicalJson(value)}\n`;
  } catch (e) {
    return err(toNexusError(e, 'E_INTERNAL'));
  }
  return atomicWrite(target, serialized, options);
}

export async function readText(target: string): Promise<Result<string, NexusError>> {
  try {
    return ok(await fs.readFile(target, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return err(nexusError('E_UNAVAILABLE', `file not found: ${target}`));
    return err(toNexusError(e, 'E_IO'));
  }
}

/**
 * Read and validate a persisted document. A file that fails validation is a
 * hard error: NEXUS never guesses at the meaning of corrupt state.
 */
export async function readJson<T>(
  target: string,
  validator: Validator<T>,
): Promise<Result<T, NexusError>> {
  const text = await readText(target);
  if (!text.ok) return text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.value);
  } catch (e) {
    return err(nexusError('E_IO', `file is not valid JSON: ${target}`, undefined, e));
  }

  const validated = validator.parse(parsed);
  if (!validated.ok) {
    return err(
      nexusError('E_INVALID_INPUT', `file failed validation: ${target}`, {
        issues: formatIssues(validated.error),
      }),
    );
  }
  return ok(validated.value);
}

export async function appendLine(target: string, line: string, fsyncData = false): Promise<Result<true, NexusError>> {
  const dirResult = await ensureDir(path.dirname(target));
  if (!dirResult.ok) return dirResult;
  try {
    const handle = await fs.open(target, 'a', 0o600);
    try {
      await handle.writeFile(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
      if (fsyncData) await handle.sync();
    } finally {
      await handle.close();
    }
    return ok(true);
  } catch (e) {
    return err(toNexusError(e, 'E_IO'));
  }
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

export async function removeFile(target: string): Promise<void> {
  await fs.rm(target, { force: true }).catch(() => undefined);
}

export async function fileSize(target: string): Promise<number | null> {
  try {
    const stat = await fs.stat(target);
    return stat.size;
  } catch {
    return null;
  }
}

export function describeIssues(issues: readonly Issue[]): string {
  return formatIssues(issues);
}
