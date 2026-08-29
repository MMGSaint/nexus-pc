import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MemorySink, createLogger } from '../../src/core/logger.js';
import { resolvePaths } from '../../src/core/paths.js';
import { BASE_POLICY, narrowPolicy } from '../../src/safety/policy.js';
import { BUILTIN_PROFILES, findBuiltinProfile } from '../../src/profiles/builtin.js';
import { ProfileStore, applicability, validateProfile } from '../../src/profiles/store.js';
import { getControl } from '../../src/safety/controls.js';
import { ALL_POWER_CAPS, capabilityMap } from '../helpers/factories.js';

const logger = createLogger(new MemorySink(), 'error');

describe('built-in profiles', () => {
  it('all pass validation against the base policy', () => {
    for (const profile of BUILTIN_PROFILES) {
      const validation = validateProfile(profile, BASE_POLICY);
      expect(validation.errors, profile.id).toEqual([]);
      expect(validation.valid, profile.id).toBe(true);
    }
  });

  it('never reference a prohibited control', () => {
    for (const profile of BUILTIN_PROFILES) {
      for (const setting of profile.settings) {
        expect(getControl(setting.control)?.safetyClass, `${profile.id}/${setting.control}`).not.toBe('prohibited');
      }
    }
  });

  it('give a rationale for every setting they change', () => {
    for (const profile of BUILTIN_PROFILES) {
      for (const setting of profile.settings) {
        expect(setting.rationale.length, `${profile.id}/${setting.control}`).toBeGreaterThan(10);
      }
    }
  });

  it('include an observation profile that changes nothing', () => {
    const observation = findBuiltinProfile('observation');
    expect(observation?.settings).toHaveLength(0);
  });

  it('do not include any contested-evidence control by default', () => {
    for (const profile of BUILTIN_PROFILES) {
      for (const setting of profile.settings) {
        expect(getControl(setting.control)?.evidenceLevel, `${profile.id}/${setting.control}`).not.toBe('contested');
      }
    }
  });
});

describe('profile validation', () => {
  const base = {
    id: 'test',
    name: 'Test',
    description: 'test',
    version: 1,
    author: 'user' as const,
    targets: ['gaming' as const],
    requiresCapabilities: [],
  };

  it('rejects a control that does not exist', () => {
    const validation = validateProfile(
      { ...base, settings: [{ control: 'not.a.control', value: 1, rationale: 'because' }] },
      BASE_POLICY,
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain('does not exist');
  });

  it('rejects a prohibited control', () => {
    const validation = validateProfile(
      { ...base, settings: [{ control: 'gpu.tuning.core_clock_offset', value: 100, rationale: 'free performance' }] },
      BASE_POLICY,
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain('prohibited');
  });

  it('rejects a value outside the policy range', () => {
    const validation = validateProfile(
      { ...base, settings: [{ control: 'power.processor.max_state', value: 10, rationale: 'x' }] },
      BASE_POLICY,
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain('outside the policy range');
  });

  it('rejects a duplicated control', () => {
    const validation = validateProfile(
      {
        ...base,
        settings: [
          { control: 'power.processor.min_state', value: 10, rationale: 'x' },
          { control: 'power.processor.min_state', value: 20, rationale: 'y' },
        ],
      },
      BASE_POLICY,
    );
    expect(validation.valid).toBe(false);
  });

  it('warns rather than fails on a contested control', () => {
    const validation = validateProfile(
      { ...base, settings: [{ control: 'os.game_mode', value: true, rationale: 'x' }] },
      BASE_POLICY,
    );
    expect(validation.valid).toBe(true);
    expect(validation.warnings.join(' ')).toContain('contested');
  });

  it('follows a narrowed policy', () => {
    const narrowed = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.min_state': { allowed: false } },
    }).policy;
    const validation = validateProfile(
      { ...base, settings: [{ control: 'power.processor.min_state', value: 20, rationale: 'x' }] },
      narrowed,
    );
    expect(validation.valid).toBe(false);
  });
});

describe('applicability', () => {
  it('separates supported from unsupported settings', () => {
    const gaming = findBuiltinProfile('gaming');
    if (!gaming) throw new Error('missing profile');
    const result = applicability(gaming, capabilityMap(ALL_POWER_CAPS));
    expect(result.applicable).toBe(true);
    expect(result.supported.length).toBeGreaterThan(0);
    expect(result.unsupported).toHaveLength(0);
  });

  it('marks a profile inapplicable when its capabilities are missing', () => {
    const gaming = findBuiltinProfile('gaming');
    if (!gaming) throw new Error('missing profile');
    const result = applicability(gaming, new Map());
    expect(result.applicable).toBe(false);
    expect(result.blockingReasons.length).toBeGreaterThan(0);
  });
});

describe('ProfileStore', () => {
  async function withStore(fn: (store: ProfileStore, home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-prof-'));
    try {
      await fn(new ProfileStore(resolvePaths(home), logger, BASE_POLICY), home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  it('loads the built-in profiles', async () => {
    await withStore(async (store) => {
      const { loaded, rejected } = await store.load();
      expect(loaded.length).toBe(BUILTIN_PROFILES.length);
      expect(rejected).toHaveLength(0);
    });
  });

  it('loads a valid user profile', async () => {
    await withStore(async (store, home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.profiles, { recursive: true });
      await writeFile(
        path.join(paths.profiles, 'mine.json'),
        JSON.stringify({
          id: 'mine',
          name: 'Mine',
          description: 'a user profile',
          version: 1,
          author: 'user',
          targets: ['gaming'],
          settings: [{ control: 'power.processor.min_state', value: 25, rationale: 'my preference' }],
          requiresCapabilities: [],
        }),
      );
      const { loaded } = await store.load();
      expect(loaded.some((p) => p.profile.id === 'mine')).toBe(true);
    });
  });

  it('rejects a user profile with an unknown field', async () => {
    await withStore(async (store, home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.profiles, { recursive: true });
      await writeFile(
        path.join(paths.profiles, 'hostile.json'),
        JSON.stringify({
          id: 'hostile',
          name: 'Hostile',
          description: 'tries to smuggle a field',
          version: 1,
          author: 'user',
          targets: ['gaming'],
          settings: [],
          requiresCapabilities: [],
          bypassSafety: true,
        }),
      );
      const { loaded, rejected } = await store.load();
      expect(loaded.some((p) => p.profile.id === 'hostile')).toBe(false);
      expect(rejected.length).toBe(1);
    });
  });

  it('rejects a user profile naming a prohibited control', async () => {
    await withStore(async (store, home) => {
      const paths = resolvePaths(home);
      await mkdir(paths.profiles, { recursive: true });
      await writeFile(
        path.join(paths.profiles, 'oc.json'),
        JSON.stringify({
          id: 'overclock',
          name: 'Overclock',
          description: 'free performance',
          version: 1,
          author: 'user',
          targets: ['gaming'],
          settings: [{ control: 'gpu.tuning.core_clock_offset', value: 200, rationale: 'faster' }],
          requiresCapabilities: [],
        }),
      );
      const { loaded, rejected } = await store.load();
      expect(loaded.some((p) => p.profile.id === 'overclock')).toBe(false);
      expect(rejected[0]?.errors.join(' ')).toContain('prohibited');
    });
  });

  it('suggests a profile that targets the workload', async () => {
    await withStore(async (store) => {
      await store.load();
      expect(store.suggestFor('gaming')?.profile.id).toBeDefined();
      expect(store.suggestFor('gaming')?.profile.id).not.toBe('observation');
    });
  });
});
