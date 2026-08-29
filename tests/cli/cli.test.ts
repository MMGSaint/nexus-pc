/**
 * CLI smoke tests.
 *
 * These run the built binary as a subprocess, which is the only way to
 * exercise argument parsing, exit codes and the human-facing output the way a
 * user actually meets them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseArgs, flagBoolean, flagNumber, flagString } from '../../src/cli/args.js';

const run = promisify(execFile);
const CLI = path.join(process.cwd(), 'dist', 'cli', 'main.js');

let home = '';
let built = false;

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'nexus-cli-'));
  built = await access(CLI).then(() => true, () => false);
});

afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function nexus(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const error = e as { code?: number; stdout?: string; stderr?: string };
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('argument parsing', () => {
  it('separates commands, positionals and flags', () => {
    const args = parseArgs(['optimize', 'extra', '--profile', 'gaming', '--dry-run', '--seconds=30']);
    expect(args.command).toBe('optimize');
    expect(args.positionals).toEqual(['extra']);
    expect(flagString(args, 'profile')).toBe('gaming');
    expect(flagBoolean(args, 'dry-run')).toBe(true);
    expect(flagNumber(args, 'seconds')).toBe(30);
  });

  it('treats a trailing flag as boolean', () => {
    expect(flagBoolean(parseArgs(['health', '--json']), 'json')).toBe(true);
  });

  it('ignores a non-numeric value where a number is expected', () => {
    expect(flagNumber(parseArgs(['observe', '--seconds', 'soon']), 'seconds')).toBeUndefined();
  });
});

describe.runIf(process.env['CI'] !== 'skip')('built CLI', () => {
  it('reports its version', async () => {
    if (!built) return;
    const result = await nexus(['version', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ nexus: expect.any(String) });
  });

  it('prints usage for an unknown command and exits non-zero', async () => {
    if (!built) return;
    const result = await nexus(['definitely-not-a-command']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown command');
  });

  it('lists controls and marks the prohibited ones', async () => {
    if (!built) return;
    const result = await nexus(['controls', '--json']);
    expect(result.code).toBe(0);
    const controls = JSON.parse(result.stdout) as { id: string; safetyClass: string }[];
    const prohibited = controls.filter((c) => c.safetyClass === 'prohibited').map((c) => c.id);
    expect(prohibited).toContain('gpu.tuning.core_clock_offset');
    expect(prohibited).toContain('memory.working_set_trim');
  });

  it('runs doctor against a fixture and labels everything mocked', async () => {
    if (!built) return;
    const result = await nexus(['doctor', '--home', path.join(home, 'doctor'), '--simulate', 'target-desktop', '--json']);
    const report = JSON.parse(result.stdout) as {
      inventory: { fidelity: string; cpu: { model: string }; gpus: { vramBytes: number }[] };
      health: { runState: string };
    };
    expect(report.inventory.fidelity).toBe('mocked');
    expect(report.inventory.cpu.model).toContain('9950X');
    expect(report.inventory.gpus[0]?.vramBytes).toBe(20 * 1024 ** 3);
    expect(report.health.runState).toBe('observation_only');
  });

  it('defaults to observation mode and changes nothing', async () => {
    if (!built) return;
    const cliHome = path.join(home, 'observe');
    const result = await nexus(['optimize', '--home', cliHome, '--simulate', 'target-desktop', '--json']);
    expect(result.code).toBe(0);
    const outcome = JSON.parse(result.stdout) as { status: string; appliedChanges: unknown[] };
    expect(outcome.status).toBe('no_action');
    expect(outcome.appliedChanges).toHaveLength(0);
  });

  it('does not claim rollback was validated when it was skipped', async () => {
    if (!built) return;
    const cliHome = path.join(home, 'firstpc');
    const result = await nexus(['first-pc', '--home', cliHome, '--simulate', 'target-desktop', '--json']);
    const report = JSON.parse(result.stdout) as {
      passed: boolean;
      rollbackValidated: boolean;
      steps: { step: string; state: string }[];
    };
    // In observation mode the change steps are skipped, and the report must
    // say rollback is unvalidated rather than passing vacuously.
    expect(report.rollbackValidated).toBe(false);
    expect(report.steps.some((s) => s.step === 'controlled change' && s.state === 'skip')).toBe(true);
    expect(report.steps.every((s) => s.state !== 'fail')).toBe(true);
  });

  it('verifies its own audit chain', async () => {
    if (!built) return;
    const cliHome = path.join(home, 'audit');
    await nexus(['health', '--home', cliHome, '--simulate', 'target-desktop']);
    const result = await nexus(['audit', 'verify', '--home', cliHome, '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true });
  });

  it('refuses a second instance while one holds the lock', async () => {
    if (!built) return;
    const cliHome = path.join(home, 'lock');
    const first = run(process.execPath, [CLI, 'run', '--home', cliHome, '--simulate', 'target-desktop', '--seconds', '4']);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const second = await nexus(['health', '--home', cliHome, '--simulate', 'target-desktop']);
    expect(second.code).toBe(3);
    expect(second.stderr).toContain('already running');
    await first.catch(() => undefined);
  }, 20_000);
});
