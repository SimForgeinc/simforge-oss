import type { ActorView } from "@simforge-oss/viewer";
import type {
  MaterializedTrafficFrameActor,
  NativeModule,
  NativeTrafficHandoff,
  StaticMapCollider,
  SumoAuthoredOccupancySource,
} from "@simforge-oss/engine";
import {
  guard,
  HANDOFF_ACTOR_ROW,
  HANDOFF_BODY_ROW,
} from "@simforge-oss/native-runtime/shared";
import type { ExternalTrafficActor } from "../index.js";

type SumoExternalActorView = SumoAuthoredOccupancySource & {
  readonly render?: ActorView;
};

/** A road user the native handoff owns, in scene ground-plane coordinates. */
export interface SumoCollisionBody {
  readonly id: string;
  readonly origin: "traffic" | "authored";
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
}

/** SUMO signal word for both indicators on: the wreck's hazard lights. */
const HAZARD_SIGNALS = 3;

/**
 * Browser collision handoff for authored vehicles striking SUMO traffic,
 * bound to the native `TrafficHandoff` world. SUMO remains authoritative for a
 * vehicle until its first contact; from then on the native contact solver
 * owns it and this binding only marshals poses: SUMO views and authored
 * proxies in, released-body poses out. Presentation, occupancy feedback and
 * capture all read the same released bodies, so they can never disagree.
 */
export class SumoCollisionHandoff {
  private readonly native: NativeTrafficHandoff;
  /** The SUMO view each released traffic actor last had under SUMO ownership. */
  private readonly trafficSources = new Map<string, ActorView>();
  /** The render each released authored actor had when its trace stopped commanding it. */
  private readonly authoredRenders = new Map<string, ActorView>();
  private trafficBodies: readonly SumoCollisionBody[] = [];
  private authoredBodies: readonly SumoCollisionBody[] = [];
  private readonly authoredById = new Map<string, SumoCollisionBody>();
  private authoredRows = new Float64Array(0);
  private trafficRows = new Float64Array(0);

  constructor(module: Pick<NativeModule, "TrafficHandoff">) {
    this.native = guard(() => new module.TrafficHandoff());
  }

  /** Map geometry released bodies collide with; retained across `clear()`. */
  setStaticColliders(colliders: readonly StaticMapCollider[]): void {
    guard(() => this.native.setStaticColliders(JSON.stringify(colliders)));
  }

  /**
   * One SUMO interval. Returns `true` when a SUMO actor left SUMO ownership
   * during this step, the frame at which presentation must snap rather than
   * interpolate from the stale SUMO pose.
   */
  step(
    deltaSeconds: number,
    authored: readonly SumoExternalActorView[],
    sumoActors: readonly ActorView[],
  ): boolean {
    if (!(deltaSeconds > 0) || !Number.isFinite(deltaSeconds)) return false;
    const authoredIds = new Array<string>(authored.length);
    const authoredKinds = new Array<string>(authored.length);
    const authoredLength = authored.length * HANDOFF_ACTOR_ROW;
    if (this.authoredRows.length < authoredLength) this.authoredRows = new Float64Array(authoredLength);
    authored.forEach((source, index) => {
      authoredIds[index] = source.id;
      authoredKinds[index] = source.kind;
      const offset = index * HANDOFF_ACTOR_ROW;
      this.authoredRows[offset] = source.x;
      this.authoredRows[offset + 1] = source.z;
      this.authoredRows[offset + 2] = source.headingRad;
      this.authoredRows[offset + 3] = source.speedMps;
      this.authoredRows[offset + 4] = source.lengthM;
      this.authoredRows[offset + 5] = source.widthM;
      this.authoredRows[offset + 6] = source.present === false ? 0 : 1;
      this.authoredRows[offset + 7] = source.static ? 1 : 0;
    });
    const sumoIds = new Array<string>(sumoActors.length);
    const sumoKinds = new Array<string>(sumoActors.length);
    const trafficLength = sumoActors.length * HANDOFF_ACTOR_ROW;
    if (this.trafficRows.length < trafficLength) this.trafficRows = new Float64Array(trafficLength);
    sumoActors.forEach((actor, index) => {
      sumoIds[index] = actor.id;
      sumoKinds[index] = actor.kind ?? "car";
      const offset = index * HANDOFF_ACTOR_ROW;
      this.trafficRows[offset] = actor.x;
      this.trafficRows[offset + 1] = actor.z;
      this.trafficRows[offset + 2] = actor.headingRad;
      this.trafficRows[offset + 3] = actor.speedMps ?? 0;
      this.trafficRows[offset + 4] = actor.dims.l;
      this.trafficRows[offset + 5] = actor.dims.w;
      this.trafficRows[offset + 6] = 1;
      this.trafficRows[offset + 7] = 0;
    });
    const released = guard(() =>
      this.native.step(
        deltaSeconds,
        authoredIds,
        authoredKinds,
        this.authoredRows.subarray(0, authoredLength),
        sumoIds,
        sumoKinds,
        this.trafficRows.subarray(0, trafficLength),
      ),
    );
    this.refresh(authored, sumoActors);
    return released > 0;
  }

  /** SUMO views with every released actor drawn from its physics body instead. */
  composeViews(
    sumoActors: readonly ActorView[],
    sampleHeight: (x: number, z: number) => number | null,
  ): readonly ActorView[] {
    if (this.trafficBodies.length === 0) return sumoActors;
    const native = sumoActors.filter((actor) => !this.trafficSources.has(actor.id));
    const physical = this.trafficBodies.map((body) => {
      const source = this.trafficSources.get(body.id)!;
      return {
        ...source,
        x: body.x,
        y: sampleHeight(body.x, body.z) ?? source.y,
        z: body.z,
        headingRad: body.headingRad,
        speedMps: body.speedMps,
        indicator: "hazard" as const,
      };
    });
    return [...native, ...physical];
  }

  /** Replace trace-owned authored poses after their first physical contact. */
  authoredViews(
    sampleHeight: (x: number, z: number) => number | null,
  ): readonly ActorView[] {
    return this.authoredBodies.map((body) => {
      const render = this.authoredRenders.get(body.id)!;
      return {
        ...render,
        x: body.x,
        y: sampleHeight(body.x, body.z) ?? render.y,
        z: body.z,
        headingRad: body.headingRad,
        speedMps: body.speedMps,
        indicator: "hazard" as const,
      };
    });
  }

  /** Feed post-impact authored occupancy to SUMO instead of future trace commands. */
  composeAuthoredSources(
    authored: readonly SumoExternalActorView[],
  ): readonly SumoExternalActorView[] {
    if (this.authoredBodies.length === 0) return authored;
    return authored.map((source) => {
      const body = this.authoredById.get(source.id);
      if (!body) return source;
      const pose = {
        x: body.x,
        z: body.z,
        headingRad: body.headingRad,
        speedMps: body.speedMps,
      };
      return {
        ...source,
        ...pose,
        render: { ...this.authoredRenders.get(source.id)!, ...pose },
      };
    });
  }

  /** Released SUMO vehicles mirrored back to SUMO as occupancy under a distinct id. */
  externalActors(): readonly ExternalTrafficActor[] {
    return this.trafficBodies.map((body) => {
      const source = this.trafficSources.get(body.id)!;
      return {
        id: `physics:${body.id}`,
        kind: "vehicle" as const,
        routeId: "proxy-route",
        x: body.x,
        z: body.z,
        headingDegrees: 90 + (body.headingRad * 180) / Math.PI,
        speedMetersPerSecond: body.speedMps,
        lengthMeters: source.dims.l,
        widthMeters: source.dims.w,
      };
    });
  }

  /**
   * The decoded SUMO frame with every released actor recorded from its physics
   * body: the same state `composeViews` presents and `externalActors` feeds
   * back. A released vehicle SUMO no longer reports stays in the frame.
   */
  composeMaterializedActors(
    actors: readonly MaterializedTrafficFrameActor[],
  ): readonly MaterializedTrafficFrameActor[] {
    if (this.trafficBodies.length === 0) return actors;
    const composed = actors.filter((actor) => !this.trafficSources.has(actor.id));
    for (const body of this.trafficBodies) {
      composed.push({
        id: body.id,
        kind: "vehicle",
        x: body.x,
        z: body.z,
        headingRad: body.headingRad,
        speedMps: body.speedMps,
        accelerationMps2: 0,
        signals: HAZARD_SIGNALS,
      });
    }
    return composed;
  }

  /** Return every actor to its owner (provider reset or timeline rewind). */
  clear(): void {
    guard(() => this.native.clear());
    this.trafficSources.clear();
    this.authoredRenders.clear();
    this.authoredById.clear();
    this.trafficBodies = [];
    this.authoredBodies = [];
  }

  /** SUMO actors currently owned by physics. */
  get actorCount(): number {
    return this.trafficBodies.length;
  }

  private refresh(
    authored: readonly SumoExternalActorView[],
    sumoActors: readonly ActorView[],
  ): void {
    if (
      this.native.bodyCount === 0 &&
      this.trafficBodies.length === 0 &&
      this.authoredBodies.length === 0
    )
      return;
    const ids = this.native.bodyIds();
    const rows = this.native.bodies();
    const traffic: SumoCollisionBody[] = [];
    const authoredBodies: SumoCollisionBody[] = [];
    this.authoredById.clear();
    ids.forEach((id, index) => {
      const offset = index * HANDOFF_BODY_ROW;
      const body: SumoCollisionBody = {
        id,
        origin: rows[offset] === 0 ? "traffic" : "authored",
        x: rows[offset + 1]!,
        z: rows[offset + 2]!,
        headingRad: rows[offset + 3]!,
        speedMps: rows[offset + 4]!,
      };
      if (body.origin === "traffic") {
        traffic.push(body);
        if (!this.trafficSources.has(id)) {
          this.trafficSources.set(id, released(sumoActors, id));
        }
      } else {
        authoredBodies.push(body);
        this.authoredById.set(id, body);
        if (!this.authoredRenders.has(id)) {
          const source = released(authored, id);
          this.authoredRenders.set(id, source.render ?? authoredRenderFallback(source));
        }
      }
    });
    this.trafficBodies = traffic;
    this.authoredBodies = authoredBodies;
  }
}

/** The native world only releases actors it was handed this step. */
function released<T extends { readonly id: string }>(actors: readonly T[], id: string): T {
  const actor = actors.find((candidate) => candidate.id === id);
  if (!actor) throw new Error(`native handoff released unknown actor ${id}`);
  return actor;
}

function authoredRenderFallback(source: SumoExternalActorView): ActorView {
  return {
    id: source.id,
    catalogId: "vehicle.sedan",
    kind: source.kind,
    x: source.x,
    y: 0,
    z: source.z,
    headingRad: source.headingRad,
    speedMps: source.speedMps,
    dims: { l: source.lengthM, w: source.widthM, h: 1.5 },
  };
}
