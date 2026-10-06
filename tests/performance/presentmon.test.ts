import { describe, expect, it } from 'vitest';
import { parsePresentMonCsv, summarizePresentMon } from '../../src/performance/presentmon.js';

describe('PresentMon adapter', () => {
  it('parses quoted CSV and derives lows from frame time', () => {
    const csv = [
      'Application,ProcessID,MsBetweenDisplayChange,Dropped',
      '"SquadGame.exe",1234,10,0',
      '"SquadGame.exe",1234,12,0',
      '"SquadGame.exe",1234,20,1',
      '',
    ].join('\n');
    const frames = parsePresentMonCsv(csv);
    const summary = summarizePresentMon(frames);
    expect(frames).toHaveLength(3);
    expect(summary.processId).toBe(1234);
    expect(summary.frames).toBe(3);
    expect(summary.fps).not.toBeNull();
    expect(summary.onePercentLowFps).not.toBeNull();
    expect(summary.droppedFrames).toBe(1);
  });

  it('returns an empty result when there is no frame data', () => {
    const summary = summarizePresentMon([]);
    expect(summary.frames).toBe(0);
    expect(summary.fps).toBeNull();
    expect(summary.onePercentLowFps).toBeNull();
  });
});
