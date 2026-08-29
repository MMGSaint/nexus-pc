/**
 * Time is injected everywhere so tests are deterministic and so that a
 * wall-clock jump (NTP correction, sleep/resume) cannot corrupt duration maths.
 *
 * - `now()`      wall clock, milliseconds since epoch. Use for timestamps.
 * - `monotonic()` monotonically non-decreasing milliseconds. Use for durations.
 */
export interface Clock {
  now(): number;
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => Number(process.hrtime.bigint() / 1_000_000n),
};

/** Deterministic clock for tests. */
export class FixedClock implements Clock {
  private wall: number;
  private mono: number;

  constructor(startMs = 1_700_000_000_000, startMonotonic = 0) {
    this.wall = startMs;
    this.mono = startMonotonic;
  }

  now(): number {
    return this.wall;
  }

  monotonic(): number {
    return this.mono;
  }

  /** Advance both clocks. */
  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }

  /** Advance only the wall clock — models an NTP correction or clock skew. */
  skewWallClock(ms: number): void {
    this.wall += ms;
  }
}

/** ISO-8601 timestamp from a clock reading, for human-facing records. */
export function isoFrom(ms: number): string {
  return new Date(ms).toISOString();
}
