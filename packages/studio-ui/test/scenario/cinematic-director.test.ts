import { describe, expect, it } from "vitest";
import type { PlaybackBundle } from "@simforge-oss/playback";
import { defaultDashCamera } from "@simforge-oss/scenario";
import {
  buildCinematicShotList,
  cinematicViewAt,
  MIN_SHOT_SECONDS,
  resolveAnchor,
  shotAt,
  type CinematicShotList,
} from "../../src/scenario/scene/cinematic-director";

type Metrics = {
  collisions?: Array<{ t: number; a: string; b: string }>;
  minTTC?: { value: number; t: number; pair: [string, string] } | null;
  minDistance?: Array<{ pair: [string, string]; minDistanceM: number; t: number }>;
  revealToConflict?: {
    observer: string;
    target: string;
    value: number;
    firstBlockedT: number;
    losOpenT: number;
    conflictT: number;
    pair: [string, string];
  } | null;
};

type FixtureTrack = {
  x: number[];
  z: number[];
  headingRad: number[];
  speedMps: number[];
  lateralOffsetM: number[];
  motionDirection: Array<1>;
  laneRsl: Array<string | null>;
  s: number[];
  present: number[];
};

/**
 * Two vehicles closing head-on over ten seconds.
 *
 * Straight lines and constant speeds on purpose: the director's output is
 * geometry, so a fixture with hand-checkable poses makes an assertion about a
 * camera position mean something.
 */
function bundle({
  seconds = 10,
  metrics = {},
  actorIds = ["ego", "challenger"],
}: { seconds?: number; metrics?: Metrics; actorIds?: string[] } = {}): PlaybackBundle {
  const steps = Math.max(2, Math.round(seconds * 10));
  const times = Array.from({ length: steps + 1 }, (_, index) => (index * seconds) / steps);
  const track = (originX: number, direction: 1 | -1): FixtureTrack => ({
    x: times.map((t) => originX + direction * t * 8),
    z: times.map(() => 0),
    headingRad: times.map(() => (direction === 1 ? 0 : Math.PI)),
    speedMps: times.map(() => 8),
    lateralOffsetM: times.map(() => 0),
    motionDirection: times.map(() => 1 as const),
    laneRsl: times.map(() => null),
    s: times.map((t) => t * 8),
    present: times.map(() => 1),
  });
  const actors = actorIds.map((id, index) => ({
    id,
    kind: "car",
    static: false,
    tags: [],
    catalogId: "vehicle.sedan",
    modelBasis: "kind-default",
    dims: { l: 4.7 + index * 0.2, w: 1.82, h: 1.45 },
    initial: { x: index === 0 ? -40 : 40, z: 0, headingRad: index === 0 ? 0 : Math.PI },
  }));
  const tracks: Record<string, FixtureTrack> = {};
  actorIds.forEach((id, index) => {
    tracks[id] = track(index === 0 ? -40 : 40, index === 0 ? 1 : -1);
  });

  return {
    instance: { manifest: { inputHash: "a".repeat(64) } },
    actors,
    props: [],
    signals: [],
    startTime: 0,
    endTime: seconds,
    trace: {
      header: { metricSubject: actorIds[0] },
      ticks: { t: times, actors: tracks, signals: {} },
      events: [],
      metrics: { collisions: [], minDistance: [], ...metrics },
    },
  } as never;
}

/**
 * The product's own windscreen mount, not a hand-rolled shape.
 *
 * `dashCameraFrame` reads mount fields this test has no business restating; an
 * invented literal typechecked and then threw at runtime, which is exactly the
 * failure a real factory prevents.
 */
const dashSensor = defaultDashCamera(
  { class: "car", dims: { length: 4.7, width: 1.82, height: 1.45 } },
  "front-dash-camera",
);

const flatGround = () => 0;

function shotKinds(shotList: CinematicShotList) {
  return shotList.shots.map((shot) => shot.kind);
}

describe("cinematic shot anchor", () => {
  it("prefers the authored reveal-to-conflict instant over derived observations", () => {
    const anchor = resolveAnchor(bundle({
      metrics: {
        revealToConflict: {
          observer: "ego", target: "challenger", value: 1.4,
          firstBlockedT: 1, losOpenT: 4.2, conflictT: 5.6, pair: ["ego", "challenger"],
        },
        collisions: [{ t: 8, a: "ego", b: "challenger" }],
        minTTC: { value: 0.4, t: 3, pair: ["ego", "challenger"] },
      },
    }));

    expect(anchor).toEqual({ anchorT: 5.6, anchorBasis: "reveal-to-conflict", pair: ["ego", "challenger"] });
  });

  it("falls back through collision, min TTC, min distance, then the clip itself", () => {
    expect(resolveAnchor(bundle({
      metrics: { collisions: [{ t: 7.5, a: "ego", b: "challenger" }, { t: 4.5, a: "ego", b: "challenger" }] },
    }))).toMatchObject({ anchorT: 4.5, anchorBasis: "collision" });

    expect(resolveAnchor(bundle({
      metrics: { minTTC: { value: 0.6, t: 6.25, pair: ["ego", "challenger"] } },
    }))).toMatchObject({ anchorT: 6.25, anchorBasis: "min-ttc" });

    expect(resolveAnchor(bundle({
      metrics: {
        minDistance: [
          { pair: ["ego", "other"], minDistanceM: 9, t: 2 },
          { pair: ["ego", "challenger"], minDistanceM: 1.2, t: 5 },
        ],
      },
    }))).toMatchObject({ anchorT: 5, anchorBasis: "min-distance", pair: ["ego", "challenger"] });

    const bare = resolveAnchor(bundle());
    expect(bare.anchorBasis).toBe("clip-midpoint");
    expect(bare.anchorT).toBeGreaterThan(0);
    expect(bare.anchorT).toBeLessThan(10);
  });

  it("clamps an out-of-range metric instant into the clip", () => {
    const anchor = resolveAnchor(bundle({
      seconds: 6,
      metrics: { collisions: [{ t: 42, a: "ego", b: "challenger" }] },
    }));

    expect(anchor.anchorT).toBe(6);
  });
});

describe("cinematic shot list", () => {
  it("is deterministic for one bundle", () => {
    const source = bundle({ metrics: { minTTC: { value: 0.5, t: 6, pair: ["ego", "challenger"] } } });

    expect(buildCinematicShotList(source)).toEqual(buildCinematicShotList(source));
  });

  it("covers the clip end to end with no gaps or overlaps", () => {
    const shotList = buildCinematicShotList(bundle({
      metrics: { minTTC: { value: 0.5, t: 6, pair: ["ego", "challenger"] } },
    }))!;

    expect(shotList.shots[0]!.startT).toBe(shotList.startTime);
    expect(shotList.shots[shotList.shots.length - 1]!.endT).toBe(shotList.endTime);
    for (let index = 1; index < shotList.shots.length; index += 1) {
      expect(shotList.shots[index]!.startT).toBe(shotList.shots[index - 1]!.endT);
    }
  });

  it("never emits a shot shorter than the cut floor", () => {
    for (const seconds of [3, 6, 10, 24]) {
      const shotList = buildCinematicShotList(bundle({ seconds }))!;
      for (const shot of shotList.shots) {
        expect(shot.endT - shot.startT).toBeGreaterThanOrEqual(MIN_SHOT_SECONDS);
      }
    }
  });

  it("collapses a clip too short to cut into a single sustained shot", () => {
    const shotList = buildCinematicShotList(bundle({ seconds: 1.5 }))!;

    expect(shotList.shots).toHaveLength(1);
    expect(shotList.shots[0]!.startT).toBe(0);
    expect(shotList.shots[0]!.endT).toBe(1.5);
  });

  it("holds the aftermath frozen at the anchor instead of following empty road", () => {
    const shotList = buildCinematicShotList(bundle({
      metrics: { collisions: [{ t: 6, a: "ego", b: "challenger" }] },
    }))!;
    const hold = shotList.shots.find((shot) => shot.kind === "aftermath-hold");

    expect(hold?.frozenAtT).toBe(6);
    expect(hold?.startT).toBeGreaterThanOrEqual(6);
  });

  it("adds the in-car beat only when a dash mount exists", () => {
    const source = bundle({ metrics: { collisions: [{ t: 7, a: "ego", b: "challenger" }] } });

    expect(shotKinds(buildCinematicShotList(source)!)).not.toContain("dash");
    expect(shotKinds(buildCinematicShotList(source, {
      dashMount: { actorId: "ego", sensor: dashSensor },
    })!)).toContain("dash");
  });

  it("refuses a clip with no duration rather than emitting a degenerate sequence", () => {
    expect(buildCinematicShotList(bundle({ seconds: 0 }))).toBeNull();
  });
});

describe("cinematic view evaluation", () => {
  const source = bundle({ metrics: { collisions: [{ t: 6, a: "ego", b: "challenger" }] } });
  const shotList = buildCinematicShotList(source, { subjectActorId: "ego" })!;

  it("yields a finite view at every instant of the clip, boundaries included", () => {
    for (let time = 0; time <= 10; time += 0.25) {
      const view = cinematicViewAt({ bundle: source, shotList, time, sampleGround: flatGround });
      expect(view).not.toBeNull();
      for (const value of [...view!.position, ...view!.target, view!.fov]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("clamps a playhead outside the clip onto the first and last shots", () => {
    expect(shotAt(shotList, -5)).toBe(shotList.shots[0]);
    expect(shotAt(shotList, 999)).toBe(shotList.shots[shotList.shots.length - 1]);
  });

  it("keeps the frozen aftermath pose identical across its whole window", () => {
    const hold = shotList.shots.find((shot) => shot.kind === "aftermath-hold")!;
    const early = cinematicViewAt({ bundle: source, shotList, time: hold.startT + 0.1, sampleGround: flatGround });
    const late = cinematicViewAt({ bundle: source, shotList, time: hold.endT - 0.05, sampleGround: flatGround });

    expect(early).toEqual(late);
  });

  it("tracks the subject while the trailing shot is active", () => {
    const chase = shotList.shots.find((shot) => shot.kind === "subject-chase")!;
    const first = cinematicViewAt({ bundle: source, shotList, time: chase.startT + 0.1, sampleGround: flatGround })!;
    const later = cinematicViewAt({ bundle: source, shotList, time: chase.endT - 0.1, sampleGround: flatGround })!;

    // The ego drives +X, so a trailing rig must advance with it.
    expect(later.position[0]).toBeGreaterThan(first.position[0]);
    expect(later.target[0]).toBeGreaterThan(first.target[0]);
  });

  it("puts the in-car eye on the mounted actor, not behind it", () => {
    const dashMount = { actorId: "ego", sensor: dashSensor };
    const withDash = buildCinematicShotList(source, { subjectActorId: "ego", dashMount })!;
    const dash = withDash.shots.find((shot) => shot.kind === "dash")!;
    const time = (dash.startT + dash.endT) / 2;
    const view = cinematicViewAt({ bundle: source, shotList: withDash, time, sampleGround: flatGround, dashMount })!;
    const egoX = -40 + time * 8;

    expect(Math.abs(view.position[0] - egoX)).toBeLessThan(3);
    expect(view.position[1]).toBeLessThan(3);
  });

  it("applies the clearance bias by rotating the shot around its subject", () => {
    const interaction = shotList.shots.find((shot) => shot.kind === "interaction-oblique")!;
    const time = (interaction.startT + interaction.endT) / 2;
    const straight = cinematicViewAt({ bundle: source, shotList, time, sampleGround: flatGround })!;
    const orbited = cinematicViewAt({
      bundle: source, shotList, time, sampleGround: flatGround, azimuthBiasRad: Math.PI / 2,
    })!;

    expect(orbited.position).not.toEqual(straight.position);
    // Rotating the eye about the target must not change what is being framed.
    expect(orbited.target).toEqual(straight.target);
  });

  it("lifts the camera onto sampled terrain rather than assuming a flat world", () => {
    const time = 5;
    const flat = cinematicViewAt({ bundle: source, shotList, time, sampleGround: flatGround })!;
    const raised = cinematicViewAt({ bundle: source, shotList, time, sampleGround: () => 12 })!;

    expect(raised.position[1] - flat.position[1]).toBeCloseTo(12, 5);
    expect(raised.target[1] - flat.target[1]).toBeCloseTo(12, 5);
  });
});
