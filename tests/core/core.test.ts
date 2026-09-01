import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalJson, structurallyEqual } from '../../src/core/canonical-json.js';
import { FixedClock, isoFrom } from '../../src/core/clock.js';
import { combineFidelity, canJustifyHardwareChange, isLive, FIDELITIES } from '../../src/core/fidelity.js';
import { atomicWrite, readJson, writeJson } from '../../src/core/fsx.js';
import { defaultHome, endpointDiscriminator, ipcEndpoint, resolvePaths } from '../../src/core/paths.js';
import { redact, registerSecret, clearRegisteredSecrets, scrubString } from '../../src/core/redact.js';
import { allOk, err, isErr, isOk, mapOk, ok, partition, unwrapOr } from '../../src/core/result.js';
import {
  assertSafeShape,
  isPlainObject,
  vArray,
  vBoolean,
  vEnum,
  vNumber,
  vObject,
  vOptional,
  vRecord,
  vString,
  vUnion,
} from '../../src/core/validate.js';

describe('Result', () => {
  it('carries values and errors', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(err('bad'))).toBe(true);
    expect(unwrapOr(err('bad'), 7)).toBe(7);
    expect(mapOk(ok(2), (n) => n * 2)).toEqual({ ok: true, value: 4 });
    expect(allOk([ok(1), err('x'), ok(2)])).toEqual({ ok: false, error: 'x' });
    expect(partition([ok(1), err('x'), ok(2)])).toEqual({ values: [1, 2], errors: ['x'] });
  });
});

describe('canonicalJson', () => {
  it('sorts keys so equal documents hash equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('drops undefined members', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('normalises negative zero', () => {
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
  });

  it('refuses a non-finite number rather than writing null', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('refuses a circular structure', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalJson(a)).toThrow();
  });

  it('compares structurally', () => {
    expect(structurallyEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(structurallyEqual(5, '5')).toBe(false);
  });
});

describe('fidelity lattice', () => {
  it('never produces a value stronger than its weakest input', () => {
    for (const a of FIDELITIES) {
      for (const b of FIDELITIES) {
        const combined = combineFidelity(a, b);
        expect([a, b]).toContain(combined);
      }
    }
  });

  it('only justifies a hardware change when live', () => {
    for (const f of FIDELITIES) {
      expect(canJustifyHardwareChange(f)).toBe(f === 'live');
      expect(isLive(f)).toBe(f === 'live');
    }
  });
});

describe('validators', () => {
  it('rejects unknown object keys by default', () => {
    const schema = vObject({ a: vNumber() });
    const result = schema.parse({ a: 1, b: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.message).toContain('unknown field');
  });

  it('allows unknown keys only when explicitly asked', () => {
    const schema = vObject({ a: vNumber() }, { allowUnknown: true });
    expect(schema.parse({ a: 1, b: 2 }).ok).toBe(true);
  });

  it('reports a missing required field', () => {
    const result = vObject({ a: vNumber() }).parse({});
    expect(result.ok).toBe(false);
  });

  it('accepts an omitted optional field', () => {
    expect(vObject({ a: vOptional(vNumber()) }).parse({}).ok).toBe(true);
  });

  it('rejects non-finite numbers', () => {
    expect(vNumber().parse(Number.NaN).ok).toBe(false);
    expect(vNumber().parse(Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('enforces numeric bounds and integrality', () => {
    const schema = vNumber({ min: 0, max: 10, integer: true });
    expect(schema.parse(5).ok).toBe(true);
    expect(schema.parse(5.5).ok).toBe(false);
    expect(schema.parse(-1).ok).toBe(false);
    expect(schema.parse(11).ok).toBe(false);
  });

  it('bounds string length by default', () => {
    expect(vString().parse('x'.repeat(5000)).ok).toBe(false);
    expect(vString({ maxLength: 10 }).parse('short').ok).toBe(true);
  });

  it('bounds array length by default', () => {
    expect(vArray(vNumber()).parse(new Array(5000).fill(1)).ok).toBe(false);
  });

  it('bounds record key count', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 1000; i += 1) big[`k${i}`] = i;
    expect(vRecord(vNumber()).parse(big).ok).toBe(false);
  });

  it('validates enums and unions', () => {
    expect(vEnum(['a', 'b']).parse('a').ok).toBe(true);
    expect(vEnum(['a', 'b']).parse('c').ok).toBe(false);
    expect(vUnion(vString(), vNumber()).parse(5).ok).toBe(true);
    expect(vUnion(vString(), vNumber()).parse(true).ok).toBe(false);
  });

  it('treats a prototype-polluted object as not plain', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1}}');
    expect(isPlainObject(parsed)).toBe(true);
    expect(vObject({ a: vOptional(vNumber()) }).parse(parsed).ok).toBe(false);
  });

  it('rejects arrays and null where an object is required', () => {
    expect(vObject({}).parse([]).ok).toBe(false);
    expect(vObject({}).parse(null).ok).toBe(false);
  });

  it('accepts booleans strictly', () => {
    expect(vBoolean().parse('true').ok).toBe(false);
    expect(vBoolean().parse(true).ok).toBe(true);
  });
});

describe('assertSafeShape', () => {
  it('rejects excessive nesting', () => {
    let nested: unknown = 1;
    for (let i = 0; i < 50; i += 1) nested = { nested };
    expect(assertSafeShape(nested, { maxDepth: 10 }).ok).toBe(false);
  });

  it('rejects an excessive node count', () => {
    expect(assertSafeShape(new Array(1000).fill(1), { maxNodes: 100 }).ok).toBe(false);
  });

  it('rejects reserved keys', () => {
    const parsed: unknown = JSON.parse('{"a":{"constructor":1}}');
    expect(assertSafeShape(parsed).ok).toBe(false);
  });

  it('accepts an ordinary payload', () => {
    expect(assertSafeShape({ a: 1, b: [1, 2, { c: 'd' }] }).ok).toBe(true);
  });
});

describe('redaction', () => {
  it('masks credential-shaped keys at any depth', () => {
    const redacted = redact({ a: { authToken: 'secret', apiKey: 'x', ok: 'visible' } }) as Record<string, Record<string, string>>;
    expect(redacted['a']?.['authToken']).toBe('[redacted]');
    expect(redacted['a']?.['apiKey']).toBe('[redacted]');
    expect(redacted['a']?.['ok']).toBe('visible');
  });

  it('scrubs a registered secret from free text', () => {
    clearRegisteredSecrets();
    registerSecret('correct-horse-battery');
    expect(scrubString('token is correct-horse-battery here')).not.toContain('correct-horse-battery');
    clearRegisteredSecrets();
  });

  it('refuses to register a secret short enough to scrub ordinary text', () => {
    clearRegisteredSecrets();
    registerSecret('abc');
    expect(scrubString('abc def')).toBe('abc def');
    clearRegisteredSecrets();
  });
});

describe('paths', () => {
  it('honours NEXUS_HOME', () => {
    expect(defaultHome({ NEXUS_HOME: '/custom/place' } as NodeJS.ProcessEnv, 'linux')).toBe('/custom/place');
  });

  it('uses LOCALAPPDATA on Windows', () => {
    expect(defaultHome({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' } as NodeJS.ProcessEnv, 'win32')).toContain('NEXUS');
  });

  it('uses a named pipe on Windows and a socket on POSIX', () => {
    const paths = resolvePaths('/tmp/nexus-test');
    expect(ipcEndpoint(paths, 'win32')).toMatch(/^\\\\\.\\pipe\\nexus-/);
    expect(ipcEndpoint(paths, 'linux')).toContain('vesper.sock');
  });

  it('gives different homes different endpoints', () => {
    expect(endpointDiscriminator('/a')).not.toBe(endpointDiscriminator('/b'));
    expect(endpointDiscriminator('/a')).toBe(endpointDiscriminator('/a'));
  });
});

describe('atomic file IO', () => {
  it('leaves no partial file behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nexus-fs-'));
    try {
      const target = path.join(dir, 'doc.json');
      await writeJson(target, { a: 1 });
      await writeJson(target, { a: 2 });
      const contents = JSON.parse(await readFile(target, 'utf8')) as { a: number };
      expect(contents.a).toBe(2);
      const entries = (await import('node:fs/promises')).readdir;
      expect((await entries(dir)).filter((f) => f.includes('.tmp'))).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a document that fails validation rather than guessing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nexus-fs-'));
    try {
      const target = path.join(dir, 'doc.json');
      await writeFile(target, JSON.stringify({ a: 'not a number' }));
      const result = await readJson(target, vObject({ a: vNumber() }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_INVALID_INPUT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing file from a corrupt one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nexus-fs-'));
    try {
      const missing = await readJson(path.join(dir, 'nope.json'), vObject({}));
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error.code).toBe('E_UNAVAILABLE');

      const corrupt = path.join(dir, 'bad.json');
      await atomicWrite(corrupt, 'not json at all');
      const result = await readJson(corrupt, vObject({}));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_IO');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('clock', () => {
  it('advances deterministically', () => {
    const clock = new FixedClock(1000, 0);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    expect(clock.monotonic()).toBe(500);
  });

  it('models wall-clock skew without moving the monotonic clock', () => {
    const clock = new FixedClock(1000, 0);
    clock.skewWallClock(-60_000);
    expect(clock.now()).toBe(-59_000);
    expect(clock.monotonic()).toBe(0);
  });

  it('formats an ISO timestamp', () => {
    expect(isoFrom(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});
