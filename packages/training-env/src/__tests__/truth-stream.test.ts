/**
 * The truth-stream wire as a live client decodes it: the engine's ground
 * contact rides on each actor record when the world simulates on a ground
 * surface, and is absent (never a zero) when it does not. Pure framing; the
 * native side is covered by `truth_frames_carry_the_engine_ground_contact` in
 * simforge-session.
 */
import { describe, expect, it } from 'vitest';

import { encodeTruthFrame, TruthStreamClient, type TruthFrame } from '../truth-stream.js';

function frame(tick: number, contact: boolean): TruthFrame {
  return {
    tick,
    timeSec: tick * 0.02,
    scene: {
      tick,
      t: tick * 0.02,
      actors: [{
        id: 'ego',
        kind: tick === 0 ? 'spawn' : 'update',
        position: [12, 0, -3],
        rotation: [0, 0, 0, 1],
        yawRad: 0,
        velocity: [1, 0, 0],
        acceleration: [0, 0, 0],
      }],
    },
    signals: [],
    actors: [{
      id: 'ego',
      class: 'car',
      dims: { l: 4.5, w: 1.9, h: 1.5 },
      accel: { ax: 0, ay: 0 },
      ...(contact ? { contact: { z: 41.625, pitchRad: 0.03, rollRad: -0.01, wheelDropM: [0, 0.01, 0, -0.02] } } : {}),
    }],
  } as TruthFrame;
}

describe('truth stream contact', () => {
  it('decodes the engine contact on every actor record, across arbitrary chunk splits', () => {
    const bytes = new Uint8Array([...encodeTruthFrame(frame(0, true)), ...encodeTruthFrame(frame(1, true))]);
    const client = new TruthStreamClient();
    const decoded = [...client.push(bytes.subarray(0, 7)), ...client.push(bytes.subarray(7))];
    expect(decoded.map((f) => f.actors[0]!.contact)).toEqual([
      { z: 41.625, pitchRad: 0.03, rollRad: -0.01, wheelDropM: [0, 0.01, 0, -0.02] },
      { z: 41.625, pitchRad: 0.03, rollRad: -0.01, wheelDropM: [0, 0.01, 0, -0.02] },
    ]);
    // The scene frame stays a ground-plane frame: the contact is the height.
    expect(decoded[0]!.scene.actors[0]!.position[1]).toBe(0);
  });

  it('leaves contact absent, not zero, for a world without a ground surface', () => {
    const [decoded] = new TruthStreamClient().push(encodeTruthFrame(frame(0, false)));
    expect(decoded!.actors[0]).not.toHaveProperty('contact');
  });
});
