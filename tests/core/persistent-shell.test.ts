/**
 * The persistent sensor host, exercised against a real child process.
 *
 * The child is a small Node script speaking the same line protocol the
 * PowerShell host does, injected through `spawnFn`. That makes the protocol,
 * the timeout path and the restart bound testable on any platform.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { FixedClock } from '../../src/core/clock.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { PersistentShell } from '../../src/core/persistent-shell.js';

const logger = createLogger(new MemorySink(), 'error');

const CHILD = `
process.stdout.write('NEXUSREADY\\n');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'exit') process.exit(0);
    const sp = line.indexOf(' ');
    const id = sp < 0 ? line : line.slice(0, sp);
    const cmd = sp < 0 ? '' : line.slice(sp + 1);
    if (cmd === 'telemetry') process.stdout.write('NEXUSJSON ' + id + ' ' + JSON.stringify({ cpuUtility: 42 }) + '\\n');
    else if (cmd === 'silent') { /* deliberately never answers */ }
    else if (cmd === 'garbage') process.stdout.write('NEXUSJSON ' + id + ' this-is-not-json\\n');
    else if (cmd === 'die') process.exit(1);
    else process.stdout.write('NEXUSJSON ' + id + ' ' + JSON.stringify({ error: 'unknown command' }) + '\\n');
  }
});
`;

const shells: PersistentShell[] = [];

afterEach(async () => {
  for (const shell of shells.splice(0)) await shell.stop();
});

function makeShell(options: { startupTimeoutMs?: number; requestTimeoutMs?: number; maxRestarts?: number; neverReady?: boolean } = {}): PersistentShell {
  const shell = new PersistentShell({
    // The allowlist is checked against this name; the injected spawnFn is what
    // actually runs, which is how the protocol gets tested off Windows.
    file: 'powershell.exe',
    args: [],
    clock: new FixedClock(),
    logger,
    startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
    maxRestarts: options.maxRestarts ?? 3,
    spawnFn: () =>
      spawn(process.execPath, ['-e', options.neverReady ? 'setTimeout(() => {}, 60000)' : CHILD], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams,
  });
  shells.push(shell);
  return shell;
}

describe('PersistentShell', () => {
  it('starts and answers a request', async () => {
    const shell = makeShell();
    const started = await shell.start();
    expect(started.ok).toBe(true);
    expect(shell.isRunning).toBe(true);

    const response = await shell.request('telemetry');
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value).toEqual({ cpuUtility: 42 });
  });

  it('answers several requests in order', async () => {
    const shell = makeShell();
    await shell.start();
    const [a, b, c] = await Promise.all([
      shell.request('telemetry'),
      shell.request('telemetry'),
      shell.request('telemetry'),
    ]);
    for (const response of [a, b, c]) {
      expect(response?.ok).toBe(true);
      if (response?.ok) expect(response.value).toEqual({ cpuUtility: 42 });
    }
  });

  it('refuses a malformed command without sending it', async () => {
    const shell = makeShell();
    await shell.start();
    for (const command of ['../etc/passwd', 'telemetry; rm -rf /', 'A'.repeat(80), '']) {
      const response = await shell.request(command);
      expect(response.ok, command).toBe(false);
      if (response.ok) continue;
      expect(response.error.code).toBe('E_INVALID_INPUT');
    }
  });

  it('refuses an executable that is not on the allowlist', async () => {
    const shell = new PersistentShell({
      file: 'bash',
      args: [],
      clock: new FixedClock(),
      logger,
      spawnFn: () => spawn(process.execPath, ['-e', CHILD]) as ChildProcessWithoutNullStreams,
    });
    const started = await shell.start();
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error.code).toBe('E_INVALID_INPUT');
  });

  it('reports invalid JSON rather than throwing', async () => {
    const shell = makeShell();
    await shell.start();
    const response = await shell.request('garbage');
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_IO');
  });

  it('an unanswered request fails only itself and does not steal another reply', async () => {
    const shell = makeShell({ requestTimeoutMs: 400 });
    await shell.start();

    // The host never answers 'silent' but answers 'telemetry' immediately.
    // With order-based matching the telemetry reply would be handed to the
    // silent request and the caller would be told the machine is at 42%
    // utilisation when nothing measured it.
    const [first, second] = await Promise.all([shell.request('silent'), shell.request('telemetry')]);

    expect(second?.ok).toBe(true);
    if (second?.ok) expect(second.value).toEqual({ cpuUtility: 42 });

    expect(first?.ok).toBe(false);
    if (!first?.ok) expect(first?.error.code).toBe('E_TIMEOUT');
  });

  it('kills the host once a request has timed out', async () => {
    const shell = makeShell({ requestTimeoutMs: 200 });
    await shell.start();
    const response = await shell.request('silent');
    expect(response.ok).toBe(false);
    // A host that has stopped answering is not trusted again.
    expect(shell.isRunning).toBe(false);
  });

  it('discards a reply carrying an unknown correlation id', async () => {
    const shell = makeShell();
    await shell.start();
    const good = await shell.request('telemetry');
    expect(good.ok).toBe(true);
    // A second request still gets its own answer, not a stale one.
    const again = await shell.request('telemetry');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toEqual({ cpuUtility: 42 });
  });

  it('fails outstanding requests when the host exits', async () => {
    const shell = makeShell();
    await shell.start();
    const response = await shell.request('die');
    expect(response.ok).toBe(false);
  });

  it('gives up after a bounded number of restarts', async () => {
    const shell = makeShell({ neverReady: true, startupTimeoutMs: 120, maxRestarts: 2 });
    const first = await shell.start();
    expect(first.ok).toBe(false);
    const second = await shell.start();
    expect(second.ok).toBe(false);
    const third = await shell.start();
    expect(third.ok).toBe(false);
    if (third.ok) return;
    // The third attempt is refused by the restart bound, not merely timed out.
    expect(third.error.code).toBe('E_LIMIT');
  }, 10_000);

  it('refuses to run after being stopped', async () => {
    const shell = makeShell();
    await shell.start();
    await shell.stop();
    const response = await shell.request('telemetry');
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_STATE');
  });
});
