import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface PresentMonFrame {
  readonly processId: number;
  readonly application: string;
  readonly frameTimeMs: number | null;
  readonly dropped: boolean | null;
}

export interface PresentMonSummary {
  readonly processId: number;
  readonly frames: number;
  readonly fps: number | null;
  readonly frameTimeMs: number | null;
  readonly onePercentLowFps: number | null;
  readonly pointOnePercentLowFps: number | null;
  readonly p95FrameTimeMs: number | null;
  readonly p99FrameTimeMs: number | null;
  readonly droppedFrames: number;
  readonly source: 'presentmon';
}

export async function capturePresentMon(options: {
  executable?: string;
  processName: string;
  durationMs?: number;
  extraArgs?: readonly string[];
}): Promise<PresentMonSummary> {
  const child = spawn(options.executable ?? 'PresentMon.exe', [
    '-process_name', options.processName,
    '-output_stdout',
    '-no_csv',
    ...(options.extraArgs ?? []),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill(), options.durationMs ?? 10_000);
  try { await once(child, 'close'); } finally { clearTimeout(timer); }

  const csv = Buffer.concat(stdout).toString('utf8');
  if (!csv.trim()) throw new Error(Buffer.concat(stderr).toString('utf8').trim() || 'PresentMon produced no CSV output.');
  return summarizePresentMon(parsePresentMonCsv(csv));
}

export function parsePresentMonCsv(csv: string): PresentMonFrame[] {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, '').replace(/\s+/g, '').toLowerCase());
  const idx = (...names: string[]) => names.map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;
  const pid = idx('processid');
  const app = idx('application');
  const frame = idx('msbetweendisplaychange', 'msbetweenpresents');
  const dropped = idx('dropped');
  const out: PresentMonFrame[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const processId = numberAt(cells, pid);
    if (processId === null) continue;
    out.push({
      processId,
      application: app >= 0 ? cells[app] ?? '' : '',
      frameTimeMs: numberAt(cells, frame),
      dropped: boolAt(cells, dropped),
    });
  }
  return out;
}

export function summarizePresentMon(frames: readonly PresentMonFrame[]): PresentMonSummary {
  const times = frames.map(f => f.frameTimeMs).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0).sort((a,b) => a-b);
  const mean = times.length ? times.reduce((a,b) => a+b, 0) / times.length : null;
  const p95 = percentile(times, .95);
  const p99 = percentile(times, .99);
  const p999 = percentile(times, .999);
  return {
    processId: frames[0]?.processId ?? 0,
    frames: times.length,
    fps: mean === null ? null : 1000 / mean,
    frameTimeMs: mean,
    onePercentLowFps: p99 === null ? null : 1000 / p99,
    pointOnePercentLowFps: p999 === null ? null : 1000 / p999,
    p95FrameTimeMs: p95,
    p99FrameTimeMs: p99,
    droppedFrames: frames.filter(f => f.dropped === true).length,
    source: 'presentmon',
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cell = ''; let quoted = false;
  for (let i=0; i<line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i+1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { out.push(cell); cell = ''; } else cell += c;
  }
  out.push(cell); return out;
}
function numberAt(cells: readonly string[], i: number): number | null {
  if (i < 0) return null; const n = Number((cells[i] ?? '').replace(/^"|"$/g, '')); return Number.isFinite(n) ? n : null;
}
function boolAt(cells: readonly string[], i: number): boolean | null {
  if (i < 0) return null; const v = (cells[i] ?? '').replace(/^"|"$/g, '').trim().toLowerCase();
  return v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : null;
}
function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null; const x = (sorted.length-1)*p; const lo = Math.floor(x); const hi = Math.ceil(x);
  if (lo === hi) return sorted[lo] ?? null; const a = sorted[lo] ?? 0; const b = sorted[hi] ?? a; return a + (b-a)*(x-lo);
}
