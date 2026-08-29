/**
 * Telemetry source interface.
 *
 * A source produces readings for a declared set of metrics. It is expected to
 * return an entry for every metric it claims — including an explicit unknown
 * when it could not read one. A source that silently omits a metric makes
 * "unavailable" indistinguishable from "nobody asked", which is the ambiguity
 * this whole layer exists to remove.
 */

import type { Clock } from '../core/clock.js';
import type { Fidelity } from '../core/fidelity.js';
import type { Logger } from '../core/logger.js';
import type { MetricId, Reading } from '../domain/telemetry.js';

export interface SampleContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timeoutMs: number;
}

export interface TelemetrySource {
  readonly id: string;
  /** Provenance of everything this source produces. */
  readonly trust: Fidelity;
  /** Metrics this source claims to be able to produce. */
  readonly metrics: readonly MetricId[];
  /** Called once before first use. May probe interfaces. */
  start?(context: SampleContext): Promise<void>;
  sample(context: SampleContext): Promise<readonly Reading[]>;
  /** Release any long-lived resource (child process, handle). */
  stop?(): Promise<void>;
}

/**
 * Wrap a source so a throw, a hang, or a fidelity overclaim cannot escape it.
 *
 * The fidelity clamp is the important part: a source registered with `mocked`
 * trust that returns a reading labelled `live` has that label reduced. A mock
 * cannot promote itself to a real measurement by lying in its output.
 */
export function sealSource(source: TelemetrySource): TelemetrySource {
  return {
    id: source.id,
    trust: source.trust,
    metrics: source.metrics,
    ...(source.start ? { start: source.start.bind(source) } : {}),
    ...(source.stop ? { stop: source.stop.bind(source) } : {}),
    sample: async (context) => {
      const readings = await source.sample(context);
      return readings.map((r) =>
        r.fidelity === source.trust ? r : { ...r, fidelity: weaker(source.trust, r.fidelity) },
      );
    },
  };
}

function weaker(a: Fidelity, b: Fidelity): Fidelity {
  const rank: Record<Fidelity, number> = { unavailable: 0, mocked: 1, simulated: 2, unverified: 3, live: 4 };
  return rank[a] <= rank[b] ? a : b;
}
