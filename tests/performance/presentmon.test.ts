import { describe, expect, it } from 'vitest';

import { parsePresentMonCsv } from '../../src/performance/presentmon.js';

describe('PresentMon CSV parser', () => {
  it('parses v2 frame timing with optional GPU/CPU columns', () => {
    const csv = [
      'Application,ProcessID,FrameTime,CPUBusy,GPUTime,MsUntilDisplayed,FinalState',
      'Squad.exe,123,8.0,4.0,6.0,10.0,Displayed',
      'Squad.exe,123,12.0,5.0,9.0,14.0,Dropped',
      'Squad.exe,123,10.0,4.5,7.0,11.0,Displayed',
    ].join('\n');

    const frames = parsePresentMonCsv(csv);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual({
      frameTimeMs: 8,
      cpuBusyMs: 4,
      gpuTimeMs: 6,
      displayLatencyMs: 10,
      dropped: false,
    });
    expect(frames[1]?.dropped).toBe(true);
  });

  it('accepts PresentMon v1 timing when v2 FrameTime is absent', () => {
    const csv = [
      'Application,ProcessID,MsBetweenPresents,PresentResult',
      'Game.exe,99,16.67,Presented',
      'Game.exe,99,16.7,Presented',
    ].join('\n');

    expect(parsePresentMonCsv(csv).map((row) => row.frameTimeMs)).toEqual([16.67, 16.7]);
  });

  it('ignores malformed/out-of-range frame records', () => {
    const csv = [
      'Application,ProcessID,FrameTime',
      'Game.exe,99,25000',
      'Game.exe,99,not-a-number',
      'Game.exe,99,16',
    ].join('\n');

    expect(parsePresentMonCsv(csv)).toEqual([{ frameTimeMs: 16 }]);
  });
});


  it('parses current frame-type and presentation cadence columns', () => {
    const csv = [
      'Application,ProcessID,FrameTime,MsBetweenPresents,MsBetweenDisplayChange,MsUntilDisplayed,FrameType,FinalState',
      'Game.exe,99,16.67,16.67,16.67,8.0,Application,Displayed',
      'Game.exe,99,8.33,8.33,8.33,5.0,AMD AFMF,Displayed',
      'Game.exe,99,8.33,8.33,8.33,12.0,Repeated,Dropped',
    ].join('\n');

    const frames = parsePresentMonCsv(csv);
    expect(frames[0]?.presentIntervalMs).toBeCloseTo(16.67);
    expect(frames[0]?.displayIntervalMs).toBeCloseTo(16.67);
    expect(frames[0]?.frameType).toBe('application');
    expect(frames[1]?.frameType).toBe('amd_afmf');
    expect(frames[2]?.frameType).toBe('repeated');
  });
