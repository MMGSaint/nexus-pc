/**
 * Workload classification.
 *
 * NEXUS can see utilisation, memory pressure and process names. It cannot see
 * intent. A user with a game open in the background while they read email is
 * indistinguishable, from telemetry alone, from a user playing that game.
 *
 * So the classifier is built to be honest about that:
 *
 *   - it always returns a confidence, and `unknown` is a normal answer;
 *   - it lists the alternatives it considered and why;
 *   - missing signals *cap* confidence rather than being treated as zeros;
 *   - process-name matching is explicitly labelled as a heuristic, because a
 *     renamed executable defeats it and an unknown game is invisible to it;
 *   - a context hint from Vesper is evidence, not an answer. If the hint and
 *     the observation disagree, the disagreement is reported rather than
 *     resolved silently in either direction.
 *
 * `MIN_ACTIONABLE_CONFIDENCE` is the floor below which a classification may be
 * reported but must not, on its own, justify changing the machine.
 */

import type { Fidelity } from '../core/fidelity.js';
import { combineFidelity } from '../core/fidelity.js';
import type {
  ClassificationCandidate,
  ContextHint,
  WorkloadClass,
  WorkloadClassification,
  WorkloadSignals,
  APPLICATION_HINTS,
} from '../domain/workload.js';
import { hintIsFresh } from '../domain/workload.js';

/**
 * Process-name hints. Matching is substring, case-insensitive, on the
 * executable name. This is a heuristic and is scored as one: a match raises a
 * candidate's score but never by itself produces high confidence.
 */
export interface ProcessHintTable {
  readonly gaming: readonly string[];
  readonly streaming: readonly string[];
  readonly development: readonly string[];
  readonly ai: readonly string[];
}

export const DEFAULT_PROCESS_HINTS: ProcessHintTable = Object.freeze({
  gaming: Object.freeze([
    'squadgame',
    'squad',
    'wherewindsmeet',
    'vrchat',
    'steamapps',
    'rdr2',
    'cyberpunk',
    'helldivers',
    'eldenring',
  ]),
  streaming: Object.freeze(['obs64', 'obs32', 'obs', 'streamlabs', 'xsplit']),
  development: Object.freeze([
    'devenv',
    'code',
    'rider64',
    'idea64',
    'msbuild',
    'cl.exe',
    'clang',
    'rustc',
    'cargo',
    'node',
    'docker',
    'wsl',
  ]),
  ai: Object.freeze(['ollama', 'lmstudio', 'koboldcpp', 'llama', 'comfyui', 'stable-diffusion']),
});

export interface ClassifierOptions {
  readonly hints?: ProcessHintTable;
}

interface Score {
  score: number;
  reasons: string[];
}

export class WorkloadClassifier {
  private readonly hints: ProcessHintTable;

  constructor(options: ClassifierOptions = {}) {
    this.hints = options.hints ?? DEFAULT_PROCESS_HINTS;
  }

  /**
   * @param nowMs Current time, used to age a context hint. Defaults to the
   *   sample timestamp; the runtime passes the real clock, because a hint
   *   declared after the last sample is current, not stale.
   */
  classify(signals: WorkloadSignals, hint?: ContextHint, nowMs?: number): WorkloadClassification {
    const evaluatedAtMs = nowMs ?? signals.timestampMs;
    const missing = missingSignals(signals);
    const scores = new Map<WorkloadClass, Score>();
    const add = (workload: WorkloadClass, delta: number, reason: string): void => {
      const current = scores.get(workload) ?? { score: 0, reasons: [] };
      current.score += delta;
      current.reasons.push(reason);
      scores.set(workload, current);
    };

    const cpu = signals.cpuUtilization;
    const gpu = signals.gpuUtilization;
    const vramRatio =
      signals.vramUsedBytes !== null && signals.vramTotalBytes !== null && signals.vramTotalBytes > 0
        ? signals.vramUsedBytes / signals.vramTotalBytes
        : null;

    /* ------------------------------------------------------- utilisation */

    if (cpu !== null && gpu !== null) {
      if (cpu < 5 && gpu < 5) add('idle', 0.9, `CPU ${cpu.toFixed(0)}% and GPU ${gpu.toFixed(0)}% are both near zero`);
      if (cpu < 25 && gpu < 20 && !(cpu < 5 && gpu < 5)) {
        add('desktop', 0.6, `light load: CPU ${cpu.toFixed(0)}%, GPU ${gpu.toFixed(0)}%`);
      }
      if (gpu >= 85 && cpu < 50) add('gpu_bound', 0.7, `GPU ${gpu.toFixed(0)}% with CPU only ${cpu.toFixed(0)}%`);
      if (cpu >= 80 && gpu < 40) add('cpu_bound', 0.7, `CPU ${cpu.toFixed(0)}% with GPU only ${gpu.toFixed(0)}%`);
      if (cpu >= 55 && gpu >= 55) add('mixed', 0.6, `both CPU (${cpu.toFixed(0)}%) and GPU (${gpu.toFixed(0)}%) are loaded`);
      if (gpu >= 70) add('gaming', 0.35, `sustained GPU load of ${gpu.toFixed(0)}%`);
    } else if (gpu !== null && gpu >= 85) {
      add('gpu_bound', 0.4, `GPU ${gpu.toFixed(0)}% (CPU utilisation unavailable)`);
    } else if (cpu !== null && cpu >= 80) {
      add('cpu_bound', 0.4, `CPU ${cpu.toFixed(0)}% (GPU utilisation unavailable)`);
    }

    if (vramRatio !== null && vramRatio > 0.75 && (gpu ?? 0) > 40) {
      add('ai_inference', 0.3, `${(vramRatio * 100).toFixed(0)}% of video memory is in use under GPU load`);
    }

    /* ------------------------------------------------------------ processes */

    const names = signals.processes.map((p) => p.name.toLowerCase());
    const matched = (list: readonly string[]): string | null =>
      names.find((n) => list.some((h) => n.includes(h))) ?? null;

    const gameProcess = matched(this.hints.gaming);

    const detectedApplicationIds = Object.entries(APPLICATION_HINTS)
      .filter(([, hints]) => hints.some((hint) => names.some((name) => name.includes(hint))))
      .map(([id]) => id);
    const streamProcess = matched(this.hints.streaming);
    const devProcess = matched(this.hints.development);
    const aiProcess = matched(this.hints.ai);

    if (gameProcess) add('gaming', 0.45, `a known game process is running ("${gameProcess}"; name matching is a heuristic)`);
    if (streamProcess) {
      add('streaming', 0.5, `a known streaming process is running ("${streamProcess}"; name matching is a heuristic)`);
      if (gameProcess) {
        // A game plus a live encoder is the streaming case, not the gaming
        // case: the game is part of the workload, and the encoder is the part
        // with the tighter timing requirement.
        add('streaming', 0.35, 'a game and a streaming encoder are running together, so the encoder is part of the workload');
      }
    }
    if (devProcess && !gameProcess) {
      add('development', 0.45, `a development process is running ("${devProcess}"; name matching is a heuristic)`);
    }
    if (aiProcess) add('ai_inference', 0.5, `a local AI process is running ("${aiProcess}"; name matching is a heuristic)`);

    /* ------------------------------------------------------------ ranking */

    const candidates: ClassificationCandidate[] = [...scores.entries()]
      .map(([workload, s]) => ({ workload, score: Math.min(1, s.score), reasons: s.reasons }))
      .sort((a, b) => b.score - a.score);

    const top = candidates[0];
    const runnerUp = candidates[1];

    let workload: WorkloadClass = top?.workload ?? 'unknown';
    let confidence = top?.score ?? 0;

    // A close second means we genuinely cannot tell the two apart.
    if (top && runnerUp && top.score - runnerUp.score < 0.15) {
      confidence *= 0.7;
    }

    // Every missing signal caps how confident the classifier is allowed to be.
    const cap = 1 - Math.min(0.6, missing.length * 0.2);
    confidence = Math.min(confidence, cap);

    if (signals.fidelity !== 'live') {
      // Simulated or mocked signals describe a model, not this machine.
      confidence = Math.min(confidence, 0.5);
    }

    if (confidence < 0.2) {
      workload = 'unknown';
    }

    /* -------------------------------------------------------------- hint */

    let contextConflict = false;
    let declaredContext: ContextHint | undefined;

    if (hint && hintIsFresh(hint, evaluatedAtMs)) {
      declaredContext = hint;
      const supported = candidates.find((c) => c.workload === hint.workload);
      if (workload === hint.workload) {
        // Agreement is corroboration, so confidence rises — but never to
        // certainty, because a hint is a claim about intent, not a measurement.
        confidence = Math.min(0.95, confidence + 0.2);
      } else if (supported && supported.score > 0.2) {
        // The observation supports the hint as a plausible alternative.
        workload = hint.workload;
        confidence = Math.min(0.8, supported.score + 0.15);
      } else {
        // The hint is not visible in the telemetry at all. Report both.
        contextConflict = true;
        confidence = Math.min(confidence, 0.5);
      }

      /*
       * Re-apply the caps. They exist because signals were missing or were not
       * live, and a hint is a claim about intent — it cannot supply evidence
       * the observation lacks. Without this, an agreeing hint could lift a
       * deliberately-capped 0.5 to 0.7 and push a classification back over the
       * action floor, so Vesper's own declaration would be the only thing that
       * authorised a change to the machine.
       */
      confidence = Math.min(confidence, cap);
      if (signals.fidelity !== 'live') confidence = Math.min(confidence, 0.5);
    }

    const fidelity: Fidelity = combineFidelity(signals.fidelity);

    return {
      timestampMs: signals.timestampMs,
      workload,
      confidence: round(confidence),
      candidates: candidates.map((c) => ({ ...c, score: round(c.score) })),
      fidelity,
      detectedApplicationIds,
      missingSignals: missing,
      ...(declaredContext === undefined ? {} : { declaredContext }),
      contextConflict,
      explanation: explain(workload, confidence, candidates, missing, contextConflict, declaredContext, detectedApplicationIds),
    };
  }
}

function missingSignals(signals: WorkloadSignals): string[] {
  const missing: string[] = [];
  if (signals.cpuUtilization === null) missing.push('cpu.utilization');
  if (signals.gpuUtilization === null) missing.push('gpu.utilization');
  if (signals.vramUsedBytes === null || signals.vramTotalBytes === null) missing.push('gpu.vram');
  if (signals.processes.length === 0) missing.push('process.enumerate');
  return missing;
}

function explain(
  workload: WorkloadClass,
  confidence: number,
  candidates: readonly ClassificationCandidate[],
  missing: readonly string[],
  conflict: boolean,
  hint: ContextHint | undefined,
  detectedApplicationIds: readonly string[],
): string {
  const parts: string[] = [];
  if (workload === 'unknown') {
    parts.push('The available signals do not distinguish one workload from another.');
  } else {
    const reasons = candidates.find((c) => c.workload === workload)?.reasons ?? [];
    parts.push(`Classified as ${workload} (confidence ${(confidence * 100).toFixed(0)}%).`);
    if (reasons.length > 0) parts.push(`Because: ${reasons.join('; ')}.`);
  }
  if (detectedApplicationIds.length > 0) {
    parts.push(`Recognized application(s): ${detectedApplicationIds.join(', ')} (process-name heuristic).`);
  }
  if (missing.length > 0) {
    parts.push(`Confidence is capped because these signals are unavailable: ${missing.join(', ')}.`);
  }
  if (conflict && hint) {
    parts.push(
      `${hint.declaredBy} declared "${hint.workload}", which is not visible in the telemetry. Reporting both rather than assuming either is right.`,
    );
  }
  return parts.join(' ');
}

function round(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}

/** Build classifier input from a telemetry snapshot plus process observations. */
export function signalsFromSnapshot(
  snapshot: {
    readonly timestampMs: number;
    readonly fidelity: Fidelity;
    readonly readings: readonly { metric: string; value: number | null; status: string }[];
  },
  processes: WorkloadSignals['processes'] = [],
): WorkloadSignals {
  const value = (metric: string): number | null => {
    const r = snapshot.readings.find((x) => x.metric === metric);
    return r && r.status === 'ok' ? r.value : null;
  };
  const used = value('memory.used');
  const total = value('memory.total');
  return {
    timestampMs: snapshot.timestampMs,
    cpuUtilization: value('cpu.utilization'),
    gpuUtilization: value('gpu.utilization'),
    vramUsedBytes: value('gpu.vram.used'),
    vramTotalBytes: value('gpu.vram.total'),
    memoryUsedRatio: used !== null && total !== null && total > 0 ? used / total : null,
    processes,
    fidelity: snapshot.fidelity,
  };
}
