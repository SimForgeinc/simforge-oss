import { describe, expect, it } from 'vitest';
import { externalActorToNetwork, transformPackedStatesToWorld } from './coordinateTransform';

const transform = { translationX: 100, translationY: -40, rotationDegrees: 90, scale: 2, invertY: false };

describe('SUMO network/world coordinates', () => {
  it('reflects packed OpenDRIVE y into scene z without reflecting x', () => {
    const reflected = { translationX: 352, translationY: -1482, rotationDegrees: 0, scale: 1, invertY: true };
    const floats = new Float32Array(8);
    floats[1] = 300;
    floats[2] = 200;
    transformPackedStatesToWorld(floats.buffer, 1, reflected);
    expect(floats[1]).toBe(652);
    expect(floats[2]).toBe(-1682);
  });

  it('mirrors an authored Yale actor onto the same network point and heading', () => {
    const yale = { translationX: 352.19, translationY: -1482.44, rotationDegrees: 0, scale: 1, invertY: true };
    expect(externalActorToNetwork({ x: 552.19, z: -1582.44, headingDegrees: 80 }, yale)).toEqual({
      x: expect.closeTo(200, 9),
      y: expect.closeTo(100, 9),
      headingDegrees: 100,
    });
  });

  it('transforms packed positions without changing hashes or signals', () => {
    const words = new Uint32Array(8);
    const floats = new Float32Array(words.buffer);
    words[0] = 123;
    floats[1] = 4;
    floats[2] = -3;
    floats[3] = 20;
    words[7] = 9;
    transformPackedStatesToWorld(words.buffer, 1, transform);
    expect(words[0]).toBe(123);
    expect(floats[1]).toBeCloseTo(106);
    expect(floats[2]).toBeCloseTo(-32);
    expect(floats[3]).toBeCloseTo(110);
    expect(words[7]).toBe(9);
  });

  it('rejects a truncated packed actor buffer', () => {
    expect(() => transformPackedStatesToWorld(new ArrayBuffer(7 * 4), 1, transform))
      .toThrow(/7 floats for 1 actors/);
  });
});
