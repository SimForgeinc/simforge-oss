import type { LaneIndex } from "@simforge-oss/editor";
import { localFromScene, obbOverlap, sweptObbTimeOfImpact, type NativeRoute, type Obb, type SimScenarioInput } from "@simforge-oss/engine/browser";
import type { TruthFrame } from "@simforge-oss/training-env/browser";
import type { PlannerAction } from "@/app/lib/live-world/types";
import { z } from "zod";

const finite = z.number().finite();
const ContractSchema = z.object({
  decisionHz: finite.positive(), deadlineMs: finite.positive(), maxResponseAgeS: finite.nonnegative(), maxResponseDistanceM: finite.nonnegative(),
  maneuvers: z.record(z.object({ accel_mps2: finite })),
  envelope: z.object({ horizon_s: finite.positive(), position_margin_m: finite.nonnegative(), tracking_margin_m: finite.nonnegative(),
    tracking_speed_error_mps: finite.nonnegative(), guaranteed_brake_mps2: finite.positive(), stop_buffer_m: finite.nonnegative() }),
  browser: z.object({ snapRadiusM: finite.positive(), maxSnapOffsetM: finite.nonnegative(), maxSnapHeadingRad: finite.positive(),
    alignmentDistanceM: finite.positive(), settlingOffsetM: finite.nonnegative(), settlingHeadingRad: finite.positive(),
    lookaheadS: finite.positive(), minLookaheadM: finite.positive(), requestTimeoutMs: finite.positive(),
    routeSampleM: finite.positive(), routeForwardM: finite.positive(), perceptionRangeM: finite.positive(),
    planStepS: finite.positive(), maxBrakeMps2: finite.positive(), otherMaxBrakeMps2: finite.positive(), stoppedMps: finite.nonnegative() }),
});
type Contract = z.infer<typeof ContractSchema>;
const AnswerSchema = z.object({ latched_maneuver: z.string(), fallback_reason: z.string().nullable(),
  confidence: finite.nullable(), api_latency_ms: finite.nullable() });
type Answer = z.infer<typeof AnswerSchema>;
const RouteSnapshotSchema = z.object({ kind: z.literal("laneChain"),
  legs: z.array(z.object({ rsl: z.string(), reversed: z.boolean() })).min(1) });
const ENDPOINT = "/api/simforge/drive/jev";

/** Per-session advisory latch. All motion remains native act setpoints, never
 * pose assignment. LaneIndex/native route geometry owns snapping and steering. */
export class JevController {
  private route: NativeRoute | null = null;
  private legs: { rsl: string; reversed: boolean; start: number; length: number }[] = [];
  private offset = { x: 0, y: 0 };
  private startArc = 0;
  private cruise = 0;
  private stopArc = Number.POSITIVE_INFINITY;
  private request: AbortController | null = null;
  private nextDecision = 0;
  private currentTime = 0;
  private currentPosition = { x: 0, y: 0 };
  private lastTick = -1;
  private held: PlannerAction | null = null;
  private answer: Answer | null = null;
  private closed = false;
  status = "Aligning with OpenDRIVE lane";

  constructor(private readonly index: LaneIndex, private readonly actorId: string,
    private readonly input: SimScenarioInput, private readonly contract: Contract) {}

  static async create(index: LaneIndex, actorId: string, input: SimScenarioInput, signal: AbortSignal) {
    const response = await fetch(ENDPOINT, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("The local Jev service is unavailable. Start jevdrive serve.");
    return new JevController(index, actorId, input, ContractSchema.parse(await response.json()));
  }

  close() {
    this.closed = true;
    this.request?.abort();
    this.route = null;
  }

  update(frame: TruthFrame): PlannerAction | null {
    if (this.closed) return null;
    if (frame.tick === this.lastTick) return this.held;
    this.lastTick = frame.tick;
    const ego = frame.scene.actors.find((a) => a.id === this.actorId && a.kind !== "despawn");
    const identity = frame.actors.find((a) => a.id === this.actorId);
    if (!ego || !identity) return null;
    const c = this.contract, b = c.browser;
    const position = localFromScene({ x: ego.position[0], z: ego.position[2] });
    const speed = Math.hypot(ego.velocity[0], ego.velocity[2]);
    this.currentTime = frame.timeSec;
    this.currentPosition = position;
    const hit = this.index.nearestForVehiclePlacement(ego.position[0], ego.position[2], b.snapRadiusM);
    const headingError = hit ? Math.atan2(Math.sin(ego.yawRad-hit.headingRad), Math.cos(ego.yawRad-hit.headingRad)) : Math.PI;
    const stopping = (): PlannerAction => ({ motionDirection: 1, targetSpeedMps: 0, targetAccelerationMps2: -Math.min(b.maxBrakeMps2, speed / b.planStepS) });
    if (!hit || hit.lane.speedLimitKph === null || hit.distance > b.maxSnapOffsetM || Math.abs(headingError) > b.maxSnapHeadingRad
      || ego.velocity[0]*Math.cos(ego.yawRad)-ego.velocity[2]*Math.sin(ego.yawRad) < -b.stoppedMps) {
      this.status = "Safety stop: no reachable forward lane";
      return this.held = stopping();
    }
    const speedCap = Math.max(0, hit.lane.speedLimitKph/3.6-c.envelope.tracking_speed_error_mps);
    if (!this.route) {
      const placement = this.index.graph.defaultPlacementRoute(hit.lane.rsl, hit.s, b.routeForwardM);
      if (!placement) {
        this.status = "Safety stop: route runway unavailable";
        return this.held = stopping();
      }
      this.route = this.index.graph.route(JSON.stringify({ kind: "lanePath", lanes: placement.lanes }));
      // The same storage-s -> travel-s convention used by editor/routeOverlay.
      // LaneIndex owns projection; native snapshot legs own traversal direction.
      let start = 0;
      const snapshot = RouteSnapshotSchema.parse(JSON.parse(this.route.snapshotJson()));
      this.legs = snapshot.legs.map((leg) => {
        const length = this.index.graph.laneLengthM(leg.rsl);
        const result = { ...leg, start, length };
        start += length;
        return result;
      });
      const first = this.legs[0]!;
      this.startArc = first.reversed ? first.length-hit.s : hit.s;
      const center = localFromScene(hit);
      this.offset = { x: position.x-center.x, y: position.y-center.y };
      this.cruise = speed; // Handover preserves current speed, not a reset to the authored spawn.
      // No unsupported signal is silently green: stop before every authored
      // control on this route. An uncontrolled corridor keeps driving.
      for (const control of [...this.input.signalPrograms, ...this.input.roadControls]) {
        for (const stop of control.stopLines) {
          const leg = this.legs.find((candidate) => candidate.rsl === stop.rsl);
          if (!leg) continue;
          const arc = leg.start + (leg.reversed ? leg.length-stop.s : stop.s);
          if (arc >= this.startArc) this.stopArc = Math.min(this.stopArc, arc);
        }
      }
      for (const leg of this.legs) {
        if (this.index.lane(leg.rsl)?.isJunction && leg.start >= this.startArc) this.stopArc = Math.min(this.stopArc, leg.start);
      }
    }
    const route = this.route;
    const leg = this.legs.find((candidate) => candidate.rsl === hit.lane.rsl);
    if (!leg) {
      this.status = "Safety stop: left the selected lane route";
      return this.held = stopping();
    }
    const arc = leg.start + (leg.reversed ? leg.length-hit.s : hit.s);
    const aligning = hit.distance > b.settlingOffsetM || Math.abs(headingError) > b.settlingHeadingRad;
    const pointAt = (distance: number) => {
      const point = route.poseAt(Math.min(route.lengthM, arc + distance));
      const u = Math.max(0, Math.min(1, (arc + distance - this.startArc) / b.alignmentDistanceM));
      const blend = 1 - u*u*u*(10+u*(-15+6*u));
      return { x: point[0]!+this.offset.x*blend, y: point[1]!+this.offset.y*blend, heading: point[2]! };
    };
    const cosine = Math.cos(ego.yawRad), sine = Math.sin(ego.yawRad);
    const relative = (x: number, y: number) => ({ x: cosine*x+sine*y, y: -sine*x+cosine*y });
    const physical = frame.scene.actors.filter((a) => a.id !== this.actorId && a.kind !== "despawn").flatMap((a) => {
      const meta = frame.actors.find((v) => v.id === a.id);
      if (!meta) return [];
      const p = localFromScene({ x: a.position[0], z: a.position[2] });
      return [{ actor: a, meta, box: { center: p, lengthM: meta.dims.l, widthM: meta.dims.w, headingRad: a.yawRad } satisfies Obb }];
    });
    const staticBoxes = this.input.occluders.map((o) => ({ ...o.obb, center: localFromScene(o.obb.center) }));
    let omitted = 0;
    const visible = physical.filter((target) => {
      const dx = target.box.center.x-position.x, dy = target.box.center.y-position.y;
      const range = Math.hypot(dx, dy);
      if (range > b.perceptionRangeM) return false;
      const ray: Obb = { center: { x: (position.x+target.box.center.x)/2, y: (position.y+target.box.center.y)/2 },
        lengthM: range, widthM: 0, headingRad: Math.atan2(dy, dx) };
      if (staticBoxes.some((box) => obbOverlap(ray, box)) || physical.some((other) => other !== target && obbOverlap(ray, other.box))) {
        omitted++;
        return false;
      }
      return true;
    });
    const objects = visible.map(({ actor, meta, box }) => {
      const p = relative(box.center.x-position.x, box.center.y-position.y);
      const v = localFromScene({ x: actor.velocity[0]-ego.velocity[0], z: actor.velocity[2]-ego.velocity[2] });
      const velocity = relative(v.x, v.y);
      return { track_id: actor.id, class: meta.class, x_m: p.x, y_m: p.y, rel_vx_mps: velocity.x, rel_vy_mps: velocity.y,
        heading_rad: actor.yawRad-ego.yawRad, length_m: meta.dims.l, width_m: meta.dims.w };
    });
    const centerline = [];
    for (let distance = -Math.min(arc, b.routeSampleM); distance <= b.routeForwardM; distance += b.routeSampleM) {
      const point = route.poseAt(Math.min(route.lengthM, arc+distance));
      const p = relative(point[0]!-position.x, point[1]!-position.y);
      centerline.push([p.x, p.y]);
      if (arc+distance >= route.lengthM) break;
    }
    const requiredStop = Number.isFinite(this.stopArc) ? Math.max(0, this.stopArc-arc) : null;
    const state = { actor_id: this.actorId, seq: frame.tick, time_s: frame.timeSec,
      ego: { speed_mps: speed, accel_mps2: identity.accel.ax*cosine+identity.accel.ay*sine,
        length_m: identity.dims.l, width_m: identity.dims.w, cruise_speed_mps: this.cruise },
      route: { centerline_m: centerline, width_m: hit.lane.widthM, speed_limit_mps: hit.lane.speedLimitKph === null ? null : hit.lane.speedLimitKph/3.6,
        required_stop_m: requiredStop, source: "OpenDRIVE LaneIndex", complete: true }, objects, omitted_occluded_objects: omitted,
      static_obbs_m_rad: staticBoxes.map((box) => { const p = relative(box.center.x-position.x, box.center.y-position.y); return [p.x,p.y,box.lengthM,box.widthM,box.headingRad-ego.yawRad]; }) };
    if (!aligning && !this.request && frame.timeSec >= this.nextDecision) {
      this.nextDecision = frame.timeSec + 1/c.decisionHz;
      const request = new AbortController();
      this.request = request;
      const deadline = setTimeout(() => request.abort(), b.requestTimeoutMs);
      const started = performance.now();
      void fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state), signal: request.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("decision service refused scene");
          const answer = AnswerSchema.parse(await response.json());
          if (this.closed) return;
          const travelled = Math.hypot(this.currentPosition.x-position.x, this.currentPosition.y-position.y);
          if (performance.now()-started > c.deadlineMs || this.currentTime-frame.timeSec > c.maxResponseAgeS || travelled > c.maxResponseDistanceM) {
            this.answer = null;
            this.status = "Safety fallback: stale or late answer";
          } else this.answer = answer;
        }).catch(() => { if (!this.closed) { this.answer = null; this.status = "Safety fallback: request failed"; } })
        .finally(() => { clearTimeout(deadline); if (this.request === request) this.request = null; });
    }
    let accel = aligning ? 0 : this.answer ? (c.maneuvers[this.answer.latched_maneuver]?.accel_mps2 ?? -b.maxBrakeMps2) : -b.maxBrakeMps2;
    const targetCap = Math.min(this.cruise, speedCap);
    if (speed >= targetCap && accel > 0) accel = 0;
    let blocked = false;
    const margin = c.envelope.position_margin_m+c.envelope.tracking_margin_m;
    const start: Obb = { center: position, headingRad: ego.yawRad, lengthM: identity.dims.l+2*margin, widthM: identity.dims.w+2*margin };
    let prior = start;
    // Per-tick swept OBB monitor, including during lane alignment. Native
    // dynamics also retain physical contacts; no unchecked raw-control path.
    for (let t = b.planStepS; t <= c.envelope.horizon_s; t += b.planStepS) {
      const duration = accel < 0 ? Math.min(t, speed/-accel) : t;
      const distance = speed*duration+accel*duration*duration/2;
      const p = pointAt(distance);
      const next: Obb = { ...start, center: p, headingRad: p.heading };
      const contact = staticBoxes.some((box) => sweptObbTimeOfImpact(prior, next, box, box) !== null)
        || visible.some(({ actor, box }) => {
          const velocity = localFromScene({ x: actor.velocity[0], z: actor.velocity[2] });
          const from = { ...box, center: { x: box.center.x+velocity.x*(t-b.planStepS), y: box.center.y+velocity.y*(t-b.planStepS) } };
          const to = { ...box, center: { x: box.center.x+velocity.x*t, y: box.center.y+velocity.y*t } };
          return sweptObbTimeOfImpact(prior, next, from, to) !== null;
        });
      if (contact || (requiredStop !== null && distance+identity.dims.l/2+speed*speed/(2*c.envelope.guaranteed_brake_mps2)+c.envelope.stop_buffer_m >= requiredStop)) {
        accel = -b.maxBrakeMps2;
        blocked = true;
        this.status = "Safety stop: occupied path or road control";
        break;
      }
      prior = next;
    }
    if (!blocked && aligning && accel >= 0) this.status = "Jev aligning position and heading";
    else if (!blocked && this.answer) this.status = `Jev ${this.answer.latched_maneuver}${this.answer.fallback_reason ? ` · ${this.answer.fallback_reason}` : ""}`;
    accel = Math.max(-speed / b.planStepS, accel);
    const preview = pointAt(Math.max(b.minLookaheadM, speed*b.lookaheadS));
    return this.held = { motionDirection: 1, targetSpeedMps: Math.max(0, Math.min(targetCap, speed+accel*b.planStepS)),
      targetAccelerationMps2: accel, previewPoint: { x: preview.x, y: preview.y }, previewHeadingRad: preview.heading };
  }
}
