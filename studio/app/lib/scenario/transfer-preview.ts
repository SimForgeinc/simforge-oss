/**
 * The 2D schematic a transfer candidate is shown with: the target map's lanes
 * around the placement and the scenario's actors where the native compiler
 * materialized them there.
 *
 * It is drawn from what the candidate check already holds — the loaded map's
 * topology and the compiled `SimScenarioInput` — so a preview costs no render,
 * no extra map download and no second compile. The output is plain numbers and
 * SVG path data in the scene frame (`x` east, `y` = scene `z`, i.e. south), so
 * the browser draws it into an `<svg>` whose y axis already points down.
 *
 * Pure: no server imports, so the geometry is unit-tested directly.
 */

import type { ScenarioTransferPreviewDto } from "@simforge-oss/studio-host";

/** A lane as the topology index stores it: xodr-local metres, `y` north. */
export type PreviewLane = {
  readonly laneType: string;
  readonly representativeWidthM?: number;
  readonly polyline: ReadonlyArray<{ x: number; y: number } | readonly [number, number]>;
};

/** A materialized actor's start, in the scene frame the compiler emits. */
export type PreviewActor = {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly length?: number;
  readonly width?: number;
};

export type PreviewInput = {
  readonly lanes: Iterable<PreviewLane>;
  readonly actors: readonly PreviewActor[];
  /** The role the scenario measures; drawn in the accent colour. */
  readonly subjectId: string | null;
  /** The subject's route start, scene frame, when it has one. */
  readonly route?: ReadonlyArray<{ x: number; z: number }> | null;
};

/** Thumbnails are 4:3; the frame is widened to that before lanes are cut. */
const ASPECT = 4 / 3;
/** Metres around the actors' extent, so the road they sit on reads as a road. */
const MARGIN_M = 18;
/** The smallest frame's half-height: one car on a straight still shows a block. */
const MIN_HALF_HEIGHT_M = 32;
/**
 * Actors further than this from the subject do not stretch the frame: a
 * formation carried as a rigid pair can put a prop 180 m away, and fitting it
 * would shrink the part of the scene that matters to a dot.
 */
const FRAME_REACH_M = 110;
/** Polyline points closer than this to the last kept one are dropped. */
const DECIMATE_M = 1.5;

const DRIVE_TYPES = new Set([
  "driving",
  "bidirectional",
  "entry",
  "exit",
  "onramp",
  "offramp",
  "connectingramp",
  "bus",
  "taxi",
  "hov",
  "biking",
]);
const WALK_TYPES = new Set(["sidewalk", "walking", "crosswalk"]);
const PARK_TYPES = new Set(["parking"]);

const VEHICLE_KINDS = new Set(["vehicle", "car", "truck", "bus", "van", "motorcycle"]);
const VRU_KINDS = new Set(["pedestrian", "bicycle", "scooter", "sidewalk_robot", "animal"]);

/** Default footprints, metres, for kinds the compiled input gives no dims for. */
const DEFAULT_DIMS: Record<string, { length: number; width: number }> = {
  vehicle: { length: 4.8, width: 1.9 },
  car: { length: 4.8, width: 1.9 },
  truck: { length: 9.5, width: 2.5 },
  bus: { length: 12, width: 2.55 },
  van: { length: 5.5, width: 2 },
  motorcycle: { length: 2.2, width: 0.8 },
  bicycle: { length: 1.8, width: 0.6 },
  pedestrian: { length: 0.6, width: 0.6 },
  scooter: { length: 1.2, width: 0.6 },
};

export type PreviewActorKind = ScenarioTransferPreviewDto["actors"][number]["kind"];

export function previewActorKind(kind: string, isSubject: boolean): PreviewActorKind {
  if (isSubject) return "subject";
  if (VEHICLE_KINDS.has(kind)) return "vehicle";
  if (VRU_KINDS.has(kind)) return "vru";
  return "object";
}

/** Road actors are the ones a lane has to be under; people and props may stand anywhere. */
export function isRoadActorKind(kind: string): boolean {
  return VEHICLE_KINDS.has(kind);
}

export function laneClass(laneType: string): "drive" | "walk" | "park" | null {
  const type = laneType.toLowerCase();
  if (DRIVE_TYPES.has(type)) return "drive";
  if (WALK_TYPES.has(type)) return "walk";
  if (PARK_TYPES.has(type)) return "park";
  return null;
}

function pointXY(point: { x: number; y: number } | readonly [number, number]): { x: number; y: number } {
  return Array.isArray(point)
    ? { x: (point as readonly [number, number])[0], y: (point as readonly [number, number])[1] }
    : (point as { x: number; y: number });
}

/** One decimal: a tenth of a metre is below a thumbnail pixel at every frame size. */
function q(value: number): number {
  return Math.round(value * 10) / 10;
}

type Frame = { minX: number; minY: number; width: number; height: number };

/**
 * The preview frame in scene coordinates: the subject and every actor within
 * `FRAME_REACH_M` of it, padded, widened to 4:3.
 */
export function previewFrame(actors: readonly PreviewActor[], subjectId: string | null): Frame {
  const subject = actors.find((actor) => actor.id === subjectId) ?? actors[0];
  const near = subject
    ? actors.filter((actor) => Math.hypot(actor.x - subject.x, actor.z - subject.z) <= FRAME_REACH_M)
    : [];
  const points = near.length > 0 ? near : [{ x: 0, z: 0 }];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  let halfHeight = Math.max(MIN_HALF_HEIGHT_M, (maxZ - minZ) / 2 + MARGIN_M);
  let halfWidth = Math.max((maxX - minX) / 2 + MARGIN_M, halfHeight * ASPECT);
  halfHeight = Math.max(halfHeight, halfWidth / ASPECT);
  halfWidth = halfHeight * ASPECT;
  return { minX: q(cx - halfWidth), minY: q(cz - halfHeight), width: q(halfWidth * 2), height: q(halfHeight * 2) };
}

function inside(frame: Frame, x: number, y: number, pad: number): boolean {
  return x >= frame.minX - pad
    && x <= frame.minX + frame.width + pad
    && y >= frame.minY - pad
    && y <= frame.minY + frame.height + pad;
}

/**
 * The lane's centreline as SVG subpaths, cut to the frame: a segment is kept
 * when its bounding box reaches the (padded) frame, so a long straight lane
 * whose two points both lie far outside still crosses the thumbnail, and
 * near-duplicate interior points are decimated.
 */
export function lanePath(polyline: PreviewLane["polyline"], frame: Frame): string {
  const pad = 12;
  const minX = frame.minX - pad;
  const maxX = frame.minX + frame.width + pad;
  const minY = frame.minY - pad;
  const maxY = frame.minY + frame.height + pad;
  const scene = polyline.map((point) => {
    const local = pointXY(point);
    return { x: local.x, y: -local.y };
  });
  const parts: string[] = [];
  let run: Array<{ x: number; y: number }> = [];
  const flush = () => {
    if (run.length >= 2) parts.push(`M${run.map((point) => `${q(point.x)} ${q(point.y)}`).join("L")}`);
    run = [];
  };
  for (let index = 1; index < scene.length; index += 1) {
    const a = scene[index - 1]!;
    const b = scene[index]!;
    const reaches = Math.max(a.x, b.x) >= minX && Math.min(a.x, b.x) <= maxX
      && Math.max(a.y, b.y) >= minY && Math.min(a.y, b.y) <= maxY;
    if (!reaches) {
      flush();
      continue;
    }
    if (run.length === 0) run.push(a);
    const last = run[run.length - 1]!;
    const isEnd = index === scene.length - 1;
    if (isEnd || Math.hypot(b.x - last.x, b.y - last.y) >= DECIMATE_M) run.push(b);
  }
  flush();
  return parts.join("");
}

export function buildTransferPreview(input: PreviewInput): ScenarioTransferPreviewDto {
  const frame = previewFrame(input.actors, input.subjectId);
  const groups = new Map<string, { kind: "drive" | "walk" | "park"; width: number; parts: string[] }>();
  for (const lane of input.lanes) {
    const kind = laneClass(lane.laneType);
    if (!kind) continue;
    const d = lanePath(lane.polyline, frame);
    if (!d) continue;
    const width = Math.round(Math.min(6, Math.max(1.5, lane.representativeWidthM ?? 3.5)) * 2) / 2;
    const key = `${kind}:${width}`;
    const group = groups.get(key) ?? { kind, width, parts: [] };
    group.parts.push(d);
    groups.set(key, group);
  }
  const order = { walk: 0, park: 1, drive: 2 } as const;
  const lanes = [...groups.values()]
    .sort((a, b) => order[a.kind] - order[b.kind] || b.width - a.width)
    .map((group) => ({ kind: group.kind, width: group.width, d: group.parts.join("") }));

  const actors = input.actors
    .filter((actor) => inside(frame, actor.x, actor.z, 6))
    .map((actor) => {
      const dims = DEFAULT_DIMS[actor.kind] ?? { length: 1, width: 1 };
      return {
        id: actor.id,
        kind: previewActorKind(actor.kind, actor.id === input.subjectId),
        x: q(actor.x),
        y: q(actor.z),
        rotateDeg: Math.round((-actor.headingRad * 180) / Math.PI),
        length: q(actor.length ?? dims.length),
        width: q(actor.width ?? dims.width),
      };
    })
    // The subject is drawn last so nothing covers it.
    .sort((a, b) => Number(a.kind === "subject") - Number(b.kind === "subject"));

  // The route runs from the subject until it first leaves the frame; the
  // point outside is kept so the line reaches the edge instead of stopping short.
  const routePoints: Array<{ x: number; z: number }> = [];
  for (const point of input.route ?? []) {
    routePoints.push(point);
    if (!inside(frame, point.x, point.z, 0)) break;
  }
  const route = routePoints.length >= 2
    ? `M${routePoints.map((point) => `${q(point.x)} ${q(point.z)}`).join("L")}`
    : null;

  return {
    viewBox: [frame.minX, frame.minY, frame.width, frame.height],
    lanes,
    route,
    actors,
  };
}
