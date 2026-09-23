import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { FIXED_SCHEDULE_V1_SCHEMA, type FixedSchedule } from '../schedule.js';
import { compareObserved, openRenderTimeline, pose, timelineRuntime } from '../timeline/index.js';
import { lowerRenderTimelineToNative } from './timeline-lowering.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TRACE = join(REPO, 'examples/edge-cases/03-red-light-ambulance-preemption/scenario.trace.json.gz');

function schedule(fps: number, seconds: number): FixedSchedule {
  return {
    schema: FIXED_SCHEDULE_V1_SCHEMA, sourceId: `rgb-${fps}`, startSeconds: 0, endSeconds: seconds,
    framesPerSecond: fps, frameCount: Math.round(fps * seconds),
  };
}

async function planeTimeline() {
  const wasm = await timelineRuntime();
  const built = wasm.RenderTimeline.buildPlane(readFileSync(TRACE), 7.5, 0.04, -0.02, undefined);
  const bytes = new TextEncoder().encode(built.toCanonicalJson());
  built.free();
  return openRenderTimeline(bytes);
}

describe('render timeline → native scene states', () => {
  it('samples every frame time through the shared sampler with baked height', async () => {
    const timeline = await planeTimeline();
    try {
      const lowering = lowerRenderTimelineToNative(timeline, [schedule(24, 19), schedule(30, 19)]);
      expect(lowering.source).toBe('render-timeline');
      expect(lowering.timelineSha256).toBe(timeline.sha256);
      expect(lowering.frameTimes.length).toBe(lowering.states.length);
      expect(lowering.states.every((state) => state.groundY === 0)).toBe(true);
      for (const [tick, state] of lowering.states.entries()) {
        const t = lowering.frameTimes[tick]!;
        for (const actor of state.actors) {
          if (actor.kind === 'despawn') continue;
          const p = pose(timeline, actor.id, t);
          expect(p.present).toBe(true);
          const [x, y, z] = actor.transform.position;
          expect(Math.abs(x - p.x)).toBeLessThan(1e-6);
          expect(Math.abs(y - p.z)).toBeLessThan(1e-6);
          expect(Math.abs(z + p.y)).toBeLessThan(1e-6);
          // Yaw-only rotation for the released service; its yaw is exact.
          const [qx, qy, qz, qw] = actor.transform.rotation;
          expect(qx).toBe(0);
          expect(qz).toBe(0);
          expect(Math.abs(Math.atan2(2 * qw * qy, 1 - 2 * qy * qy) - Math.atan2(Math.sin(p.headingRad), Math.cos(p.headingRad)))).toBeLessThan(1e-5);
        }
      }
    } finally {
      timeline.free();
    }
  });

  it('spawns once, despawns on the first absent frame, and never draws after', async () => {
    const timeline = await planeTimeline();
    try {
      const lowering = lowerRenderTimelineToNative(timeline, [schedule(25, 20)]);
      const kinds = lowering.states.map((state) => state.actors.find((actor) => actor.id === 'ambulance')?.kind ?? null);
      expect(kinds[0]).toBe('spawn');
      const despawn = kinds.indexOf('despawn');
      expect(despawn).toBeGreaterThan(0);
      expect(kinds.slice(1, despawn).every((kind) => kind === 'update')).toBe(true);
      expect(kinds.slice(despawn + 1).every((kind) => kind === null)).toBe(true);
      expect(pose(timeline, 'ambulance', lowering.frameTimes[despawn]!).present).toBe(false);
      expect(pose(timeline, 'ambulance', lowering.frameTimes[despawn - 1]!).present).toBe(true);
    } finally {
      timeline.free();
    }
  });

  it('carries sampler/2 wheel spin, body attitude and wheel drop on vehicle records', async () => {
    const timeline = await planeTimeline();
    try {
      const withAttitude = lowerRenderTimelineToNative(timeline, [schedule(25, 10)], { attitude: true });
      const yawOnly = lowerRenderTimelineToNative(timeline, [schedule(25, 10)]);
      const ambulance = (lowering: typeof yawOnly, tick: number) =>
        lowering.states[tick]!.actors.find((actor) => actor.id === 'ambulance')!;
      const tick = 100;
      const t = withAttitude.frameTimes[tick]!;
      const p = pose(timeline, 'ambulance', t);
      const record = ambulance(withAttitude, tick);
      expect(record.wheelSpinRad).toBeCloseTo(p.wheelSpinRad!, 5);
      expect(record.bodyAttitude!.pitchRad).toBeCloseTo(p.bodyPitchRad, 5);
      expect(record.bodyAttitude!.rollRad).toBeCloseTo(p.bodyRollRad, 5);
      expect(record.wheelDropM).toHaveLength(4);
      // Yaw-only frames carry no attitude of any kind, but keep the odometer.
      const plain = ambulance(yawOnly, tick);
      expect(plain.bodyAttitude).toBeUndefined();
      expect(plain.wheelDropM).toBeUndefined();
      expect(plain.wheelSpinRad).toBeCloseTo(p.wheelSpinRad!, 5);
    } finally {
      timeline.free();
    }
  });

  it('a renderer that draws the lowered states exactly passes the Bevy parity gate', async () => {
    const timeline = await planeTimeline();
    try {
      const lowering = lowerRenderTimelineToNative(timeline, [schedule(24, 19)], { attitude: true });
      const observed = lowering.states.map((state, tick) => JSON.stringify({
        tick, time: lowering.frameTimes[tick],
        actors: state.actors.filter((actor) => actor.kind !== 'despawn').map((actor) => ({
          id: actor.id,
          position: actor.transform.position.map((v) => Math.fround(v)),
          rotation: actor.transform.rotation.map((v) => Math.fround(v)),
          visible: true,
        })),
      })).join('\n');
      const report = compareObserved(timeline, observed, 'bevy');
      expect(report.pass).toBe(true);
      expect(report.maxPositionErrorM).toBeLessThan(1e-3);
      expect(report.maxHeadingErrorDeg).toBeLessThan(0.05);
      expect(report.maxPitchErrorDeg).toBeLessThan(0.05);
    } finally {
      timeline.free();
    }
  });

  it('rejects frame times beyond the clip', async () => {
    const timeline = await planeTimeline();
    try {
      expect(() => lowerRenderTimelineToNative(timeline, [schedule(24, 21)])).toThrow(/exceeds the timeline clip end/);
    } finally {
      timeline.free();
    }
  });

  it('builds canonical bytes whose sha256 is the timeline digest', async () => {
    const { buildRenderTimeline } = await import('../timeline/index.js');
    const { createHash } = await import('node:crypto');
    const gz = readFileSync(TRACE);
    // A trace on a synthetic flat map: build through the xodr path needs a real
    // map, so exercise the canonical-bytes contract through buildFlat instead.
    const wasm = await timelineRuntime();
    const flat = wasm.RenderTimeline.buildFlat(gunzipSync(gz), 0, undefined);
    const bytes = flat.toCanonicalJson();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(flat.sha256);
    flat.free();
    expect(typeof buildRenderTimeline).toBe('function');
  });
});
