/**
 * Built-in profiles.
 *
 * Every profile lists exactly the controls it changes and why. Applying a
 * profile changes those settings and nothing else — there is no hidden tail of
 * "additional tuning". That is what makes the promise "NEXUS never silently
 * makes undocumented changes" something you can check rather than trust.
 *
 * Note what is *not* here: no registry tweaks of contested value, no service
 * disabling, no memory "cleaning". Those either have no measured benefit or
 * cannot be measured by NEXUS, and shipping them as defaults would be exactly
 * the cargo-cult behaviour this system is built to avoid. Controls with
 * contested evidence remain reachable, but only by explicit human request.
 */

import type { ProfileDocument } from '../domain/profile.js';
import { OBSERVATION_PROFILE_ID } from '../domain/profile.js';

const defineProfile = (profile: ProfileDocument): ProfileDocument => Object.freeze(profile);

export const BUILTIN_PROFILES: readonly ProfileDocument[] = Object.freeze([
  defineProfile({
    id: OBSERVATION_PROFILE_ID,
    name: 'Observation',
    description:
      'Changes nothing. NEXUS measures, classifies and reports only. This is the profile a new installation starts in, and the one it falls back to when it is degraded.',
    version: 1,
    author: 'builtin',
    targets: Object.freeze(['idle', 'desktop', 'gaming', 'streaming', 'development', 'ai_inference', 'unknown']),
    settings: Object.freeze([]),
    requiresCapabilities: Object.freeze([]),
  }),

  defineProfile({
    id: 'efficiency',
    name: 'Efficiency',
    description:
      'Lets the processor drop to low performance states when idle and keeps boost conservative. Intended for a machine that is on but not working.',
    version: 1,
    author: 'builtin',
    targets: Object.freeze(['idle', 'desktop']),
    settings: Object.freeze([
      {
        control: 'power.processor.min_state',
        value: 5,
        rationale: 'Allow the processor to idle down instead of holding a high floor.',
      },
      {
        control: 'power.processor.boost_mode',
        value: 3,
        rationale: 'Efficient boost: still boosts, but weighs power against performance.',
      },
    ]),
    requiresCapabilities: Object.freeze(['power.setting.read', 'power.setting.write']),
  }),

  defineProfile({
    id: 'balanced',
    name: 'Balanced',
    description:
      'A middle setting suitable for mixed desktop use. Keeps the full performance range available without pinning the processor high at idle.',
    version: 1,
    author: 'builtin',
    targets: Object.freeze(['desktop', 'development', 'unknown']),
    settings: Object.freeze([
      {
        control: 'power.processor.min_state',
        value: 5,
        rationale: 'Let the processor idle down; the ceiling still allows full performance on demand.',
      },
      {
        control: 'power.processor.max_state',
        value: 100,
        rationale: 'Keep the whole performance range available.',
      },
      {
        control: 'power.processor.boost_mode',
        value: 2,
        rationale: 'Aggressive boost, which is the default behaviour on a desktop part.',
      },
    ]),
    requiresCapabilities: Object.freeze(['power.setting.read', 'power.setting.write']),
  }),

  defineProfile({
    id: 'gaming',
    name: 'Gaming',
    description:
      'Keeps cores unparked and the processor responsive so frame pacing is not affected by the processor ramping up. Deliberately does not touch GPU tuning: NEXUS does not perform silicon-level tuning.',
    version: 1,
    author: 'builtin',
    targets: Object.freeze(['gaming', 'gpu_bound']),
    settings: Object.freeze([
      {
        control: 'power.processor.min_state',
        value: 20,
        rationale: 'A modest floor reduces ramp-up latency without holding the whole package at high clocks.',
      },
      {
        control: 'power.processor.max_state',
        value: 100,
        rationale: 'Full performance available for frame-time-sensitive work.',
      },
      {
        control: 'power.processor.core_parking_min',
        value: 100,
        rationale: 'Keep all cores unparked so a thread waking on a parked core does not stall.',
      },
      {
        control: 'power.processor.boost_mode',
        value: 2,
        rationale: 'Aggressive boost for latency-sensitive frame work.',
      },
    ]),
    requiresCapabilities: Object.freeze(['power.setting.read', 'power.setting.write']),
  }),

  defineProfile({
    id: 'streaming',
    name: 'Streaming',
    description:
      'For playing and encoding at the same time. Prioritises consistent processor availability for the encoder over peak single-thread clocks, since a dropped frame is more visible than a slightly lower average.',
    version: 1,
    author: 'builtin',
    targets: Object.freeze(['streaming']),
    settings: Object.freeze([
      {
        control: 'power.processor.min_state',
        value: 30,
        rationale: 'Keep the package responsive so encoder threads are not waiting on a frequency ramp.',
      },
      {
        control: 'power.processor.max_state',
        value: 100,
        rationale: 'Full range available for the encode plus the game.',
      },
      {
        control: 'power.processor.core_parking_min',
        value: 100,
        rationale: 'Encoding spreads across many threads; parked cores cost frames.',
      },
    ]),
    requiresCapabilities: Object.freeze(['power.setting.read', 'power.setting.write']),
  }),

  defineProfile({
    id: 'workstation',
    name: 'Workstation',
    description:
      'For sustained all-core work such as compilation or local AI inference. Keeps every core available and boost aggressive.',
    version: 1,
    author: 'builtin',
    targets: Object.freeze(['development', 'ai_inference', 'cpu_bound', 'mixed']),
    settings: Object.freeze([
      {
        control: 'power.processor.core_parking_min',
        value: 100,
        rationale: 'Sustained parallel work should not wait for cores to unpark.',
      },
      {
        control: 'power.processor.max_state',
        value: 100,
        rationale: 'Full performance for long compute runs.',
      },
      {
        control: 'power.processor.boost_mode',
        value: 2,
        rationale: 'Aggressive boost for throughput.',
      },
    ]),
    requiresCapabilities: Object.freeze(['power.setting.read', 'power.setting.write']),
  }),
]);

export function findBuiltinProfile(id: string): ProfileDocument | undefined {
  return BUILTIN_PROFILES.find((p) => p.id === id);
}
