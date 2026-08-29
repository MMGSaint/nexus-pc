import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FixedClock } from '../../src/core/clock.js';
import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { EventLog } from '../../src/audit/eventlog.js';
import { VesperServer } from '../../src/vesper/server.js';
import { DEFAULT_SCOPES, MUTATING_SCOPES, VESPER_CONTRACT_VERSION, methodScope } from '../../src/vesper/contract.js';
import type { VesperHost } from '../../src/vesper/handlers.js';
import type { OptimizationOutcome } from '../../src/domain/optimization.js';
import { TestVesperClient } from '../helpers/vesper-client.js';

const logger = createLogger(new MemorySink(), 'error');
const TOKEN = 'test-token-that-is-long-enough-1234567890';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const MOCK_OUTCOME: OptimizationOutcome = {
  id: 'opt_1',
  proposalId: 'prop_1',
  status: 'applied_kept',
  startedAtMs: 1,
  finishedAtMs: 2,
  // Produced by a mock actuator. This must never be reported as live.
  fidelity: 'mocked',
  workload: 'gaming',
  appliedChanges: [],
  rolledBack: false,
  checkpointId: null,
  measurements: [],
  summary: 'simulated outcome',
  findings: [],
};

function fakeHost(overrides: Partial<VesperHost> = {}): VesperHost {
  return {
    requesterId: 'vesper',
    now: () => 1_700_000_000_000,
    getStatus: async () => ({ runState: 'ready' }) as never,
    getCapabilities: async () => [],
    getTelemetrySummary: async () => ({
      fromMs: 0,
      toMs: 1,
      metrics: [],
      fidelity: 'mocked' as const,
      sampleCount: 1,
    }),
    getCurrentProfile: async () => ({ profile: null, appliedAtMs: null }),
    listProfiles: async () => [],
    analyzeWorkload: async () =>
      ({
        timestampMs: 1,
        workload: 'gaming',
        confidence: 0.8,
        candidates: [],
        fidelity: 'mocked',
        missingSignals: [],
        contextConflict: false,
        explanation: 'test',
      }) as never,
    declareContext: async () => ({ accepted: true, note: 'recorded as context' }),
    recommend: async () => ({ workload: { fidelity: 'mocked' } }) as never,
    optimize: async () => MOCK_OUTCOME,
    rollback: async () => ({ checkpointId: 'ckpt_1', complete: true, entries: [] }),
    getOptimizationResult: async () => MOCK_OUTCOME,
    ...overrides,
  };
}

async function startServer(
  scopes: readonly string[] = DEFAULT_SCOPES,
  host: VesperHost = fakeHost(),
): Promise<{ server: VesperServer; endpoint: string; client: TestVesperClient; eventLog: EventLog }> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-vesper-'));
  const paths = resolvePaths(home);
  const clock = new FixedClock();
  const eventLog = new EventLog({ paths, clock, logger, sessionId: 'sess' });
  await eventLog.open();

  const endpoint = path.join(home, 'v.sock');
  const server = new VesperServer({
    paths,
    clock,
    logger,
    eventLog,
    token: TOKEN,
    scopes,
    host,
    platform: 'linux',
    endpoint,
  });
  const started = await server.start();
  if (!started.ok) throw started.error;

  const client = new TestVesperClient();
  await client.connect(endpoint);

  cleanups.push(async () => {
    client.close();
    await server.stop();
    await rm(home, { recursive: true, force: true });
  });

  return { server, endpoint, client, eventLog };
}

describe('transport', () => {
  it('listens on a filesystem path, never a network port', async () => {
    const { endpoint, server } = await startServer();
    expect(server.listening).toBe(true);
    // A path, not host:port.
    expect(endpoint).not.toMatch(/^\d{1,3}(\.\d{1,3}){3}:/);
    expect(endpoint).not.toMatch(/localhost:/);
    expect(endpoint.startsWith('/') || endpoint.startsWith('\\\\.\\pipe\\')).toBe(true);
  });
});

describe('authentication', () => {
  it('accepts a correct token', async () => {
    const { client } = await startServer();
    const response = await client.call('getStatus', TOKEN);
    expect(response.ok).toBe(true);
  });

  it('rejects a wrong token', async () => {
    const { client } = await startServer();
    const response = await client.call('getStatus', 'wrong-token-wrong-token-wrong-token');
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_AUTH');
  });

  it('rejects an empty token', async () => {
    const { client } = await startServer();
    const response = await client.call('getStatus', '');
    expect(response.ok).toBe(false);
  });

  it('records a rejected client in the audit log', async () => {
    const { client, eventLog } = await startServer();
    await client.call('getStatus', 'definitely-not-the-right-token-here');
    const events = await eventLog.readAll();
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.map((e) => e.kind)).toContain('vesper.rejected');
  });

  it('never writes the token into the audit log', async () => {
    const { client, eventLog } = await startServer();
    await client.call('getStatus', TOKEN);
    const events = await eventLog.readAll();
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(JSON.stringify(events.value)).not.toContain(TOKEN);
  });
});

describe('scopes', () => {
  it('does not grant optimize, rollback or context by default', () => {
    for (const scope of MUTATING_SCOPES) {
      expect(DEFAULT_SCOPES).not.toContain(scope);
    }
  });

  it('refuses a method whose scope has not been granted', async () => {
    const { client } = await startServer();
    const response = await client.call('optimize', TOKEN);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_SCOPE');
    expect(response.error.message).toContain('has not been granted');
  });

  it('refuses rollback without the rollback scope', async () => {
    const { client } = await startServer();
    const response = await client.call('rollback', TOKEN, { checkpointId: 'ckpt_1' });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_SCOPE');
  });

  it('allows a method once its scope is granted on this machine', async () => {
    const { client } = await startServer([...DEFAULT_SCOPES, 'optimize']);
    const response = await client.call('optimize', TOKEN);
    expect(response.ok).toBe(true);
  });

  it('maps every method to a scope', () => {
    for (const method of ['getStatus', 'optimize', 'rollback', 'declareContext']) {
      expect(methodScope(method)).not.toBeNull();
    }
    expect(methodScope('deleteEverything')).toBeNull();
  });
});

describe('fidelity honesty', () => {
  it('reports a mocked outcome as mocked, never as live', async () => {
    const { client } = await startServer([...DEFAULT_SCOPES, 'optimize']);
    const response = await client.call('optimize', TOKEN);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.fidelity).toBe('mocked');
    expect(response.fidelity).not.toBe('live');
  });

  it('carries a fidelity on every response, including failures', async () => {
    const { client } = await startServer();
    const good = await client.call('getStatus', TOKEN);
    const bad = await client.call('optimize', TOKEN);
    expect(good.fidelity).toBeDefined();
    expect(bad.fidelity).toBeDefined();
  });

  it('propagates telemetry fidelity rather than asserting live', async () => {
    const { client } = await startServer();
    const response = await client.call('getTelemetrySummary', TOKEN, { windowMs: 60_000 });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.fidelity).toBe('mocked');
  });
});

describe('input validation', () => {
  it('rejects a malformed line', async () => {
    const { client } = await startServer();
    const response = await client.sendRaw('this is not json');
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_INVALID_INPUT');
  });

  it('rejects an unknown top-level field', async () => {
    const { client } = await startServer();
    const response = await client.sendRaw(
      JSON.stringify({ v: VESPER_CONTRACT_VERSION, id: 'x', method: 'getStatus', token: TOKEN, bypassSafety: true }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toContain('unknown field');
  });

  it('rejects an unknown parameter', async () => {
    const { client } = await startServer();
    const response = await client.call('getStatus', TOKEN, { elevate: true });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_INVALID_INPUT');
  });

  it('rejects deeply nested payloads', async () => {
    const { client } = await startServer();
    let nested: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) nested = { nested };
    const response = await client.sendRaw(
      JSON.stringify({ v: VESPER_CONTRACT_VERSION, id: 'x', method: 'getStatus', token: TOKEN, params: nested }),
    );
    expect(response.ok).toBe(false);
  });

  it('rejects a __proto__ key', async () => {
    const { client } = await startServer();
    const response = await client.sendRaw(
      `{"v":"${VESPER_CONTRACT_VERSION}","id":"x","method":"getStatus","token":"${TOKEN}","__proto__":{"polluted":true}}`,
    );
    expect(response.ok).toBe(false);
    expect((({}) as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('rejects an unknown method', async () => {
    const { client } = await startServer();
    const response = await client.call('rm-rf', TOKEN);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toContain('unknown method');
  });

  it('rejects an incompatible contract version', async () => {
    const { client } = await startServer();
    const response = await client.call('getStatus', TOKEN, undefined, '99.0.0');
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_UNSUPPORTED');
  });

  it('requires a checkpointId for rollback', async () => {
    const { client } = await startServer([...DEFAULT_SCOPES, 'rollback']);
    const response = await client.call('rollback', TOKEN);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe('E_INVALID_INPUT');
  });
});

describe('context declaration', () => {
  it('records a declared context as a hint rather than a command', async () => {
    let received: unknown = null;
    const { client } = await startServer([...DEFAULT_SCOPES, 'context'], fakeHost({
      declareContext: async (hint) => {
        received = hint;
        return { accepted: true, note: 'recorded as context' };
      },
    }));

    const response = await client.call('declareContext', TOKEN, {
      workload: 'streaming',
      note: 'user said they are about to stream',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect((response.result as { note: string }).note).toContain('context');
    expect(received).toMatchObject({ workload: 'streaming', declaredBy: 'vesper' });
    // A hint has a lifetime; it does not persist as a standing instruction.
    expect((received as { ttlMs: number }).ttlMs).toBeGreaterThan(0);
  });
});

describe('handler failures', () => {
  it('turns a throwing handler into an error response, not a crash', async () => {
    const { client } = await startServer(DEFAULT_SCOPES, fakeHost({
      getStatus: async () => {
        throw new Error('internal explosion');
      },
    }));
    const response = await client.call('getStatus', TOKEN);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.message).toContain('internal explosion');
  });
});
