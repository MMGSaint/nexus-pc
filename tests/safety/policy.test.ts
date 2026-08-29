import { describe, expect, it } from 'vitest';

import { BASE_POLICY, narrowPolicy, policyDigest } from '../../src/safety/policy.js';
import { BUILTIN_CONTROLS } from '../../src/safety/controls.js';

describe('base policy', () => {
  it('has an explicit entry for every known control', () => {
    for (const control of BUILTIN_CONTROLS) {
      expect(BASE_POLICY.controls[control.id], control.id).toBeDefined();
    }
  });

  it('defaults unlisted controls to not-allowed', () => {
    // Prohibited controls are never opted in by the base policy.
    for (const control of BUILTIN_CONTROLS.filter((c) => c.safetyClass === 'prohibited')) {
      expect(BASE_POLICY.controls[control.id]?.allowed, control.id).toBe(false);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(BASE_POLICY)).toBe(true);
    expect(Object.isFrozen(BASE_POLICY.global)).toBe(true);
    expect(Object.isFrozen(BASE_POLICY.controls)).toBe(true);
  });

  it('never permits the processor ceiling to fall below half', () => {
    expect(BASE_POLICY.controls['power.processor.max_state']?.range?.min).toBeGreaterThanOrEqual(50);
  });
});

describe('narrowPolicy', () => {
  it('is a no-op without an override', () => {
    const result = narrowPolicy(BASE_POLICY, undefined);
    expect(policyDigest(result.policy)).toBe(policyDigest(BASE_POLICY));
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('accepts a stricter numeric range', () => {
    const { policy, applied } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.max_state': { range: { min: 80, max: 95 } } },
    });
    expect(policy.controls['power.processor.max_state']?.range).toEqual({ min: 80, max: 95 });
    expect(applied.some((a) => a.path.includes('max_state'))).toBe(true);
  });

  it('refuses to widen a numeric range and reports the attempt', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.max_state': { range: { min: 0, max: 100 } } },
    });
    expect(policy.controls['power.processor.max_state']?.range?.min).toBe(50);
    expect(rejected.some((r) => r.path === 'controls.power.processor.max_state.range.min')).toBe(true);
  });

  it('cannot re-allow a control the base policy disallows', () => {
    const hostile = { controls: { 'gpu.tuning.core_clock_offset': { allowed: true } } } as unknown as Parameters<typeof narrowPolicy>[1];
    const { policy } = narrowPolicy(BASE_POLICY, hostile);
    expect(policy.controls['gpu.tuning.core_clock_offset']?.allowed).toBe(false);
  });

  it('cannot switch observation-only back off', () => {
    const observing = narrowPolicy(BASE_POLICY, { global: { observationOnly: true } });
    expect(observing.policy.global.observationOnly).toBe(true);

    const hostile = { global: { observationOnly: false } } as unknown as Parameters<typeof narrowPolicy>[1];
    const attempt = narrowPolicy(observing.policy, hostile);
    expect(attempt.policy.global.observationOnly).toBe(true);
  });

  it('cannot lower a confirmation requirement', () => {
    const hostile = {
      controls: { 'os.gpu.hardware_scheduling': { requiresConfirmation: false } },
    } as unknown as Parameters<typeof narrowPolicy>[1];
    const { policy } = narrowPolicy(BASE_POLICY, hostile);
    expect(policy.controls['os.gpu.hardware_scheduling']?.requiresConfirmation).toBe(true);
  });

  it('cannot raise the per-proposal change limit', () => {
    const hostile = { global: { maxChangesPerProposal: 9999 } };
    const { policy, rejected } = narrowPolicy(BASE_POLICY, hostile);
    expect(policy.global.maxChangesPerProposal).toBe(BASE_POLICY.global.maxChangesPerProposal);
    expect(rejected.some((r) => r.path === 'global.maxChangesPerProposal')).toBe(true);
  });

  it('cannot shorten a cooldown', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.boost_mode': { cooldownMs: 1 } },
    });
    expect(policy.controls['power.processor.boost_mode']?.cooldownMs).toBe(
      BASE_POLICY.controls['power.processor.boost_mode']?.cooldownMs,
    );
    expect(rejected.some((r) => r.path.includes('cooldownMs'))).toBe(true);
  });

  it('cannot raise a thermal ceiling', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.boost_mode': { thermal: { maxCpuTemperatureC: 105 } } },
    });
    expect(policy.controls['power.processor.boost_mode']?.thermal?.maxCpuTemperatureC).toBe(85);
    expect(rejected.some((r) => r.path.includes('thermal'))).toBe(true);
  });

  it('lowers a thermal ceiling when asked', () => {
    const { policy } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.boost_mode': { thermal: { maxCpuTemperatureC: 70 } } },
    });
    expect(policy.controls['power.processor.boost_mode']?.thermal?.maxCpuTemperatureC).toBe(70);
  });

  it('intersects enum options rather than extending them', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'process.priority.foreground': { allowedValues: ['normal', 'high'] } },
    });
    expect(policy.controls['process.priority.foreground']?.allowedValues).toEqual(['normal']);
    expect(rejected.some((r) => r.path.includes('allowedValues'))).toBe(true);
  });

  it('ignores an override naming a control that does not exist', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'invented.control': { allowed: false } },
    });
    expect(policy.controls['invented.control']).toBeUndefined();
    expect(rejected.some((r) => r.path === 'controls.invented.control')).toBe(true);
  });

  it('never produces a non-finite bound from a one-sided override', () => {
    // Regression: an override giving only a min for a control with no base
    // range used to produce max: Infinity, which made policyDigest throw and
    // stopped the safety kernel being constructible at all.
    for (const control of BUILTIN_CONTROLS) {
      for (const side of [{ min: 1 }, { max: 1 }, { min: 1, max: 50 }]) {
        const { policy } = narrowPolicy(BASE_POLICY, { controls: { [control.id]: { range: side } } });
        const range = policy.controls[control.id]?.range;
        if (range) {
          expect(Number.isFinite(range.min), `${control.id} min`).toBe(true);
          expect(Number.isFinite(range.max), `${control.id} max`).toBe(true);
        }
        expect(() => policyDigest(policy), `${control.id} ${JSON.stringify(side)}`).not.toThrow();
      }
    }
  });

  it('refuses a range override on a control that has no numeric range', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'os.game_mode': { range: { min: 1 } } },
    });
    expect(policy.controls['os.game_mode']?.range).toBeUndefined();
    expect(rejected.some((r) => r.path === 'controls.os.game_mode.range')).toBe(true);
  });

  it('bounds an override by the control value spec when the policy has no range', () => {
    // power.pcie.aspm has a base range; power.processor.idle_disable's spec is
    // 0..1, so an override there is clamped by the spec rather than by nothing.
    const { policy } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.idle_disable': { range: { min: 1 } } },
    });
    const range = policy.controls['power.processor.idle_disable']?.range;
    expect(range?.min).toBe(1);
    expect(Number.isFinite(range?.max ?? Number.NaN)).toBe(true);
  });

  it('refuses an override that inverts the bounds', () => {
    const { policy, rejected } = narrowPolicy(BASE_POLICY, {
      controls: { 'power.processor.max_state': { range: { min: 95, max: 60 } } },
    });
    expect(policy.controls['power.processor.max_state']?.range).toEqual({ min: 50, max: 100 });
    expect(rejected.some((r) => r.path === 'controls.power.processor.max_state.range')).toBe(true);
  });

  it('is idempotent', () => {
    const once = narrowPolicy(BASE_POLICY, { global: { maxChangesPerProposal: 2 } });
    const twice = narrowPolicy(once.policy, { global: { maxChangesPerProposal: 2 } });
    expect(policyDigest(twice.policy)).toBe(policyDigest(once.policy));
    expect(twice.applied).toHaveLength(0);
  });
});
