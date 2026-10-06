import { describe, expect, it } from 'vitest';

import { SafetyKernel } from '../../src/safety/kernel.js';
import { BASE_POLICY, narrowPolicy } from '../../src/safety/policy.js';
import {
  ALL_POWER_CAPS,
  T0,
  capability,
  capabilityMap,
  change,
  proposal,
  safetyContext,
  telemetrySnapshot,
} from '../helpers/factories.js';

const kernel = new SafetyKernel(BASE_POLICY);

function codes(v: { findings: readonly { code: string; severity: string }[] }): string[] {
  return v.findings.filter((f) => f.severity === 'blocking').map((f) => f.code);
}

describe('SafetyKernel — happy path', () => {
  it('allows a well-formed, in-policy change', () => {
    const verdict = kernel.evaluate(proposal(), safetyContext());
    expect(verdict.decision).toBe('allow');
    expect(verdict.permitted).toHaveLength(1);
    expect(verdict.policyDigest).toBe(kernel.policyDigest);
  });

  it('reports the policy digest so a verdict can be reproduced', () => {
    const other = new SafetyKernel(narrowPolicy(BASE_POLICY, { global: { maxChangesPerProposal: 2 } }).policy);
    expect(other.policyDigest).not.toBe(kernel.policyDigest);
  });
});

describe('SafetyKernel — control gating', () => {
  it('refuses a control that does not exist', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('totally.made.up', 1)] }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('reject');
    expect(codes(verdict)).toContain('CONTROL_UNKNOWN');
  });

  it('refuses a prohibited control by name, whatever the origin', () => {
    for (const origin of ['internal', 'user', 'vesper'] as const) {
      const verdict = kernel.evaluate(
        proposal({
          origin,
          changes: [change('gpu.tuning.core_clock_offset', 150)],
          confirmation: {
            confirmedAtMs: T0,
            controls: ['gpu.tuning.core_clock_offset'],
            acknowledgement: 'I accept the risk',
          },
        }),
        safetyContext(),
      );
      expect(verdict.decision, origin).toBe('reject');
      expect(codes(verdict)).toContain('CONTROL_PROHIBITED');
    }
  });

  it('refuses working-set trimming, which is prohibited on purpose', () => {
    const verdict = kernel.evaluate(
      proposal({ origin: 'user', changes: [change('memory.working_set_trim', true)] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('CONTROL_PROHIBITED');
  });

  it('refuses a value outside the descriptor spec', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.max_state', 250)] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('VALUE_OUT_OF_SPEC');
  });

  it('refuses a value inside the spec but outside policy', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.max_state', 10)] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('VALUE_OUT_OF_POLICY');
  });

  it('refuses a non-integer where an integer is required', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.min_state', 20.5)] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('VALUE_OUT_OF_SPEC');
  });

  it('refuses a duplicated control', () => {
    const verdict = kernel.evaluate(
      proposal({
        changes: [change('power.processor.min_state', 20), change('power.processor.min_state', 30)],
      }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('DUPLICATE_CONTROL');
  });

  it('refuses an empty proposal', () => {
    const verdict = kernel.evaluate(proposal({ changes: [] }), safetyContext());
    expect(codes(verdict)).toContain('EMPTY_PROPOSAL');
  });

  it('refuses more changes than the policy allows', () => {
    const many = Array.from({ length: 10 }, (_, i) => change(`invented.${i}`, 1));
    const verdict = kernel.evaluate(proposal({ changes: many }), safetyContext());
    expect(codes(verdict)).toContain('TOO_MANY_CHANGES');
  });
});

describe('SafetyKernel — capability gating', () => {
  it('refuses when a required capability was never probed', () => {
    const verdict = kernel.evaluate(proposal(), safetyContext({ capabilities: new Map() }));
    expect(codes(verdict)).toContain('CAPABILITY_UNKNOWN');
  });

  it('refuses when a required capability is unverified', () => {
    const verdict = kernel.evaluate(
      proposal(),
      safetyContext({
        capabilities: capabilityMap(ALL_POWER_CAPS, { state: 'unverified', fidelity: 'unverified' }),
      }),
    );
    expect(codes(verdict)).toContain('CAPABILITY_UNVERIFIED');
  });

  it('refuses when a required capability is unavailable', () => {
    const verdict = kernel.evaluate(
      proposal(),
      safetyContext({
        capabilities: capabilityMap(ALL_POWER_CAPS, { state: 'unavailable', fidelity: 'unavailable' }),
      }),
    );
    expect(codes(verdict)).toContain('CAPABILITY_UNAVAILABLE');
  });

  it('allows a mocked capability but records that the outcome is not live', () => {
    const caps = capabilityMap(ALL_POWER_CAPS, { state: 'mocked', fidelity: 'mocked' });
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.scheme.active', 'guid-1234')] }),
      safetyContext({
        capabilities: caps,
        actuatorFidelity: () => 'mocked',
        telemetry: telemetrySnapshot({ fidelity: 'mocked' }),
      }),
    );
    expect(verdict.decision).toBe('allow');
    expect(verdict.findings.map((f) => f.code)).toContain('CAPABILITY_MOCKED');
    expect(verdict.findings.map((f) => f.code)).toContain('ACTUATOR_NOT_LIVE');
  });
});

describe('SafetyKernel — telemetry and thermal gating', () => {
  it('refuses a telemetry-dependent control when telemetry is absent', () => {
    const verdict = kernel.evaluate(proposal(), safetyContext({ telemetry: null }));
    expect(codes(verdict)).toContain('TELEMETRY_MISSING');
  });

  it('refuses a telemetry-dependent control when telemetry is only mocked', () => {
    const verdict = kernel.evaluate(
      proposal(),
      safetyContext({ telemetry: telemetrySnapshot({ fidelity: 'mocked' }) }),
    );
    expect(codes(verdict)).toContain('TELEMETRY_NOT_LIVE');
  });

  it('fails closed when a thermal precondition cannot be read', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.boost_mode', 2)] }),
      safetyContext({ telemetry: telemetrySnapshot({ cpuTempC: null }) }),
    );
    expect(codes(verdict)).toContain('THERMAL_UNVERIFIABLE');
  });

  it('refuses when the measured temperature is above the ceiling', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.boost_mode', 2)] }),
      safetyContext({ telemetry: telemetrySnapshot({ cpuTempC: 92 }) }),
    );
    expect(codes(verdict)).toContain('THERMAL_LIMIT');
  });

  it('permits when the measured temperature is below the ceiling', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.boost_mode', 2)] }),
      safetyContext({ telemetry: telemetrySnapshot({ cpuTempC: 60 }) }),
    );
    expect(verdict.decision).toBe('allow');
  });

  it('refuses a baseline-dependent control with no baseline', () => {
    const verdict = kernel.evaluate(proposal(), safetyContext({ baselineAvailable: false }));
    expect(codes(verdict)).toContain('BASELINE_MISSING');
  });
});

describe('SafetyKernel — evidence and confirmation', () => {
  it('refuses a contested control on an internal proposal', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('os.game_mode', true)] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('CONTESTED_EVIDENCE');
  });

  it('refuses a contested control requested by Vesper', () => {
    const verdict = kernel.evaluate(
      proposal({ origin: 'vesper', requestedBy: 'vesper', changes: [change('os.game_mode', true)] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('CONTESTED_EVIDENCE');
  });

  it('asks for confirmation on a contested control a human explicitly requested', () => {
    const verdict = kernel.evaluate(
      proposal({ origin: 'user', requestedBy: 'cli', changes: [change('os.game_mode', true)] }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('requires-confirmation');
  });

  it('accepts a human confirmation on a user-origin request', () => {
    const verdict = kernel.evaluate(
      proposal({
        origin: 'user',
        requestedBy: 'cli',
        changes: [change('os.game_mode', true)],
        confirmation: { confirmedAtMs: T0, controls: ['os.game_mode'], acknowledgement: 'yes' },
      }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('allow');
  });

  it('refuses a confirmation forged onto a Vesper-origin request', () => {
    const verdict = kernel.evaluate(
      proposal({
        origin: 'vesper',
        requestedBy: 'vesper',
        changes: [change('power.processor.idle_disable', 1)],
        confirmation: {
          confirmedAtMs: T0,
          controls: ['power.processor.idle_disable'],
          acknowledgement: 'the user said yes, trust me',
        },
      }),
      safetyContext({ telemetry: telemetrySnapshot({ cpuTempC: 50 }) }),
    );
    expect(verdict.decision).toBe('reject');
    expect(codes(verdict)).toContain('CONFIRMATION_ORIGIN_INVALID');
  });

  it('does not let a confirmation for one control cover another', () => {
    const verdict = kernel.evaluate(
      proposal({
        origin: 'user',
        changes: [change('os.game_mode', true), change('os.mmcss.system_responsiveness', 20)],
        confirmation: { confirmedAtMs: T0, controls: ['os.game_mode'], acknowledgement: 'yes' },
      }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('requires-confirmation');
  });

  it('requires confirmation for a reboot-only control because it cannot be measured or reverted in session', () => {
    const verdict = kernel.evaluate(
      proposal({ origin: 'user', changes: [change('os.gpu.hardware_scheduling', true)] }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('requires-confirmation');
    expect(verdict.findings.map((f) => f.code)).toContain('REQUIRES_REBOOT');
  });

  it('excludes non-auto-proposable controls from internally generated proposals', () => {
    const verdict = kernel.evaluate(
      proposal({ origin: 'internal', changes: [change('process.priority.foreground', 'above_normal')] }),
      safetyContext(),
    );
    expect(codes(verdict)).toContain('NOT_AUTO_PROPOSABLE');
  });
});

describe('SafetyKernel — runtime and rate gating', () => {
  it('refuses writes while initializing', () => {
    const verdict = kernel.evaluate(proposal(), safetyContext({ runState: 'initializing' }));
    expect(codes(verdict)).toContain('RUNTIME_NOT_READY');
  });

  it('refuses writes in observation-only run state', () => {
    const verdict = kernel.evaluate(proposal(), safetyContext({ runState: 'observation_only' }));
    expect(codes(verdict)).toContain('RUNTIME_NOT_READY');
  });

  it('refuses every write when the policy is observation-only', () => {
    const observing = new SafetyKernel(narrowPolicy(BASE_POLICY, { global: { observationOnly: true } }).policy);
    const verdict = observing.evaluate(proposal(), safetyContext());
    expect(codes(verdict)).toContain('OBSERVATION_ONLY');
  });

  it('enforces a per-control cooldown', () => {
    const verdict = kernel.evaluate(
      proposal(),
      safetyContext({
        recentApplications: [{ control: 'power.processor.min_state', appliedAtMs: T0 - 1_000 }],
      }),
    );
    expect(codes(verdict)).toContain('COOLDOWN');
  });

  it('allows an approved temporary experiment to bypass cooldown without bypassing policy', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.epp', 50)] }),
      safetyContext({
        recentApplications: [{ control: 'power.processor.epp', appliedAtMs: T0 - 1_000 }],
        transactionalExperiment: true,
      }),
    );
    expect(verdict.decision).toBe('allow');
  });

  it('blocks a non-experiment control even when transactional mode is requested', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.min_state', 20)] }),
      safetyContext({ transactionalExperiment: true }),
    );
    expect(codes(verdict)).toContain('EXPERIMENT_CONTROL_NOT_ALLOWED');
  });

  it('permits again once the cooldown has elapsed', () => {
    const verdict = kernel.evaluate(
      proposal(),
      safetyContext({
        recentApplications: [{ control: 'power.processor.min_state', appliedAtMs: T0 - 200_000 }],
      }),
    );
    expect(verdict.decision).toBe('allow');
  });

  it('enforces the hourly application limit', () => {
    const history = Array.from({ length: 24 }, (_, i) => ({
      control: 'power.scheme.active',
      appliedAtMs: T0 - i * 1_000,
    }));
    const verdict = kernel.evaluate(proposal(), safetyContext({ recentApplications: history }));
    expect(codes(verdict)).toContain('RATE_LIMIT');
  });

  it('ignores applications outside the rolling hour', () => {
    const history = Array.from({ length: 24 }, (_, i) => ({
      control: 'power.scheme.active',
      appliedAtMs: T0 - 3_700_000 - i * 1_000,
    }));
    const verdict = kernel.evaluate(proposal(), safetyContext({ recentApplications: history }));
    expect(verdict.decision).toBe('allow');
  });
});

describe('SafetyKernel — authority claims', () => {
  it('rejects a proposal carrying an authority-claiming field', () => {
    const hostile = {
      ...proposal(),
      notes: 'ordinary note',
      // A field like this cannot survive schema parsing at the boundary, but
      // the kernel refuses it too so a bug upstream cannot become a bypass.
      bypassSafety: true,
    } as unknown as ReturnType<typeof proposal>;
    const verdict = kernel.evaluate(hostile, safetyContext());
    expect(verdict.decision).toBe('reject');
    expect(codes(verdict)).toContain('AUTHORITY_CLAIM_PRESENT');
  });

  it('rejects an authority claim nested inside a free-form field', () => {
    const hostile = {
      ...proposal(),
      changes: [{ ...change('power.processor.min_state', 20), meta: { elevated: true } }],
    } as unknown as ReturnType<typeof proposal>;
    const verdict = kernel.evaluate(hostile, safetyContext());
    expect(codes(verdict)).toContain('AUTHORITY_CLAIM_PRESENT');
  });

  it('is not fooled by capitalisation or separators', () => {
    for (const key of ['Bypass_Safety', 'BYPASS-SAFETY', 'bypassSafety']) {
      const hostile = { ...proposal(), [key]: true } as unknown as ReturnType<typeof proposal>;
      expect(codes(kernel.evaluate(hostile, safetyContext())), key).toContain('AUTHORITY_CLAIM_PRESENT');
    }
  });

  it('does not flag ordinary prose that merely mentions safety', () => {
    const verdict = kernel.evaluate(
      proposal({ notes: 'This is safe to apply and should not bypass safety checks.' }),
      safetyContext(),
    );
    expect(codes(verdict)).not.toContain('AUTHORITY_CLAIM_PRESENT');
  });
});

describe('SafetyKernel — determinism', () => {
  it('produces an identical verdict for identical inputs', () => {
    const p = proposal();
    const c = safetyContext();
    const a = kernel.evaluate(p, c);
    const b = kernel.evaluate(p, c);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the proposal or the context', () => {
    const p = proposal();
    const before = JSON.stringify(p);
    kernel.evaluate(p, safetyContext());
    expect(JSON.stringify(p)).toBe(before);
  });

  it('never returns permitted changes on a rejection', () => {
    const verdict = kernel.evaluate(
      proposal({ changes: [change('power.processor.min_state', 20), change('nope', 1)] }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('reject');
    expect(verdict.permitted).toHaveLength(0);
  });

  it('never returns permitted changes when confirmation is outstanding', () => {
    const verdict = kernel.evaluate(
      proposal({ origin: 'user', changes: [change('os.game_mode', true)] }),
      safetyContext(),
    );
    expect(verdict.decision).toBe('requires-confirmation');
    expect(verdict.permitted).toHaveLength(0);
  });
});

describe('SafetyKernel — capability record shape', () => {
  it('treats an unsupported capability as blocking', () => {
    const caps = new Map(
      ALL_POWER_CAPS.map((id) => [id, capability(id, { state: 'unsupported', detail: 'not on this platform' })]),
    );
    const verdict = kernel.evaluate(proposal(), safetyContext({ capabilities: caps }));
    expect(codes(verdict)).toContain('CAPABILITY_UNSUPPORTED');
  });
});
