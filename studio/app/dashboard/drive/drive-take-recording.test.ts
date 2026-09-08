import { parseSimScenarioInput } from "@simforge-oss/engine";
import { sessions } from "@simforge-oss/training-env/node";
import { describe, expect, it } from "vitest";

import {
  appendTakeSamples,
  applyEgoControl,
  authoredAdvanceTicks,
  authoredWorldUnbounded,
  createAuthoredWorldSession,
  finishTakeRecording,
  initialTakeSample,
  type ManualDriveSample,
} from "../../lib/live-world/authored-world-session";

const graph = sessions().engine.laneGraph({
  source: { xodrSha256: "fixture" },
  lanes: {},
  gates: [],
  junctions: {},
});

const CLIP_S = 2;
const DT = 0.02;

function worldInput() {
  return parseSimScenarioInput({
    mapId: "drive-take-recording",
    clipSeconds: CLIP_S,
    warmupSeconds: 0,
    dt: DT,
    physics: { mode: "dynamic-v1" },
    actors: [{
      id: "ego",
      kind: "car",
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: "polyline", points: [{ x: 0, z: 0 }, { x: 200, z: 0 }] }, cruiseSpeedMps: 8 },
      tags: ["role:driver"],
    }],
  });
}

/** Drive the worker's take path against the real native session: batches of ticks, frames pulled after each. */
function runTake(direction: 1 | -1, control: { throttle: number; brake: number }, ticksPerBatch = 3) {
  const input = worldInput();
  const world = createAuthoredWorldSession(sessions(), input, graph);
  const truth = world.subscribeTruth();
  const samples: ManualDriveSample[] = [initialTakeSample(world, "ego", direction)];
  expect(applyEgoControl(world, "ego", { actorId: "ego", steer: 0, ...control, reverse: direction === -1 }, 0)).toEqual({ ok: true });
  for (;;) {
    const ticks = authoredAdvanceTicks(ticksPerBatch, world.time(), input.clipSeconds, input.dt, false);
    if (ticks === 0) break;
    world.advance(ticks);
    appendTakeSamples(samples, truth.frames(), "ego", direction);
  }
  expect(truth.stats.dropped).toBe(0);
  return { input, world, samples };
}

describe("Drive take recording", () => {
  it("records one sample per engine tick from t = 0 through the clip end and seals a complete recording", () => {
    const { input, world, samples } = runTake(1, { throttle: 1, brake: 0 });
    const recording = finishTakeRecording(samples, input.clipSeconds, input.dt);
    expect(recording.version).toBe(1);
    expect(recording.clipSeconds).toBe(CLIP_S);
    expect(recording.samples.length).toBe(Math.round(CLIP_S / DT) + 1);
    expect(recording.samples[0]!.timeS).toBe(0);
    expect(recording.samples.at(-1)!.timeS).toBeCloseTo(CLIP_S, 6);
    for (let index = 1; index < recording.samples.length; index += 1) {
      expect(recording.samples[index]!.timeS).toBeGreaterThan(recording.samples[index - 1]!.timeS);
    }
    // The bounded transport parks exactly at the clip end.
    expect(world.time()).toBeCloseTo(CLIP_S, 6);
    // Held throttle moved the ego; the path is the simulated one, not the input.
    const last = recording.samples.at(-1)!;
    expect(last.x).toBeGreaterThan(0);
    expect(last.speedMps).toBeGreaterThan(0);
    for (const sample of recording.samples) expect(Number.isFinite(sample.headingRad)).toBe(true);
  });

  it("signs speed by the commanded gear and refuses to seal a partial take", () => {
    const { samples } = runTake(-1, { throttle: 1, brake: 0 });
    expect(samples.at(-1)!.speedMps).toBeLessThan(0);
    expect(() => finishTakeRecording(samples.slice(0, -1), CLIP_S, DT)).toThrow(/incomplete/);
    expect(() => finishTakeRecording(samples.slice(1), CLIP_S, DT)).toThrow(/incomplete/);
  });

  it("bounds the world only when no free-driving ego owns it", () => {
    expect(authoredWorldUnbounded(null, "free")).toBe(false);
    expect(authoredWorldUnbounded("ego", "take")).toBe(false);
    expect(authoredWorldUnbounded("ego", "free")).toBe(true);
    expect(authoredAdvanceTicks(4, 19.95, 20, 0.02, false)).toBe(3);
    expect(authoredAdvanceTicks(4, 20, 20, 0.02, false)).toBe(0);
    expect(authoredAdvanceTicks(4, 20, 20, 0.02, true)).toBe(4);
    expect(authoredAdvanceTicks(4, 95, 20, 0.02, true)).toBe(4);
  });

  it("keeps advancing the native live world past the clip end under a free-driving ego", () => {
    const input = worldInput();
    const world = createAuthoredWorldSession(sessions(), input, graph);
    applyEgoControl(world, "ego", { actorId: "ego", steer: 0, throttle: 1, brake: 0 }, 0);
    const pastClip = Math.round(CLIP_S / DT) + 25;
    world.advance(authoredAdvanceTicks(pastClip, world.time(), input.clipSeconds, input.dt, true));
    expect(world.time()).toBeGreaterThan(CLIP_S);
    expect(applyEgoControl(world, "ego", { actorId: "ego", steer: 0, throttle: 1, brake: 0 }, 1)).toEqual({ ok: true });
    const before = world.snapshot().actors.find((actor) => actor.id === "ego")!.x;
    world.advance(10);
    expect(world.snapshot().actors.find((actor) => actor.id === "ego")!.x).toBeGreaterThan(before);
  });
});
