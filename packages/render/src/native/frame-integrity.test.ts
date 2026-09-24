import { describe, expect, it } from 'vitest';

import { nativeFrameIntegrity } from './engine.js';
import { NativeRunDiagnosticsSchema } from './evidence.js';

describe('frame integrity evidence', () => {
  it('totals the non-finite pixels and lists the affected camera frames', () => {
    const frames = [{ tick: 3, sensorId: 'front', pixels: 8 }, { tick: 4, sensorId: 'front', pixels: 2 }];
    expect(nativeFrameIntegrity(frames)).toEqual({ nonFinitePixels: 10, frames });
    expect(nativeFrameIntegrity([])).toEqual({ nonFinitePixels: 0, frames: [] });
    expect(nativeFrameIntegrity(Array.from({ length: 150 }, (_, tick) => ({ tick, sensorId: 'a', pixels: 1 }))).frames).toHaveLength(100);
  });

  it('is a diagnostics key', () => {
    expect(Object.keys(NativeRunDiagnosticsSchema.shape)).toContain('frameIntegrity');
  });
});
