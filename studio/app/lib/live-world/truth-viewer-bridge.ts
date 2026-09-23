import type { TruthFrame } from '@simforge-oss/training-env/browser';
import { getEntry } from '@simforge-oss/asset-catalog';
import {
  ThreeRendererAdapter,
  actorOrigin,
  followCameraPose,
  indexedWorldHeightSampler,
  type ActorRenderState,
  type ActorRenderer,
  type CityViewer,
} from '@simforge-oss/viewer';

import { SnapshotClock, bracketSnapshots, lerp, lerpAngle, type SnapshotClockOptions } from './snapshot-clock';

export interface TruthViewerBridgeOptions {
  layer?: string;
  groundLift?: boolean;
  /**
   * The authored asset for an actor id, or null when the world did not
   * author one (then the truth class picks a generic stand-in). Consulted
   * once per actor id and cached until the next `reset`; an authored id
   * unknown to the asset catalog is an error, never a silent generic substitute.
   */
  authoredCatalogId?: (actorId: string) => string | null;
  /** Where an appearance failure is reported; rendering stops until the next `reset`. */
  onError?: (error: Error) => void;
  /** Wall clock in milliseconds; `performance.now` unless a test drives time itself. */
  now?: () => number;
  /** Tuning for the render clock; see {@link SnapshotClock}. */
  clock?: SnapshotClockOptions;
}

export interface TruthViewerBridge {
  readonly actors: ActorRenderer;
  /**
   * Buffer a frame. Newer frames only (by tick); older ones are dropped. Use
   * `reset` when the world legitimately restarts. Nothing is drawn here —
   * frames arrive whenever the world's channel delivers them, and drawing on
   * arrival is what made the car stutter — except the very first frame, so
   * the world's actors appear the moment it has any.
   */
  apply(frame: TruthFrame): void;
  /**
   * The world was rebuilt at t = 0: forget the tick watermark, the buffered
   * frames and the render clock so the new generation's first frame (tick 0)
   * renders immediately instead of being dropped as stale.
   */
  reset(): void;
  rendered(actorId: string): ActorRenderState | null;
  /**
   * Draw one actor before the world has produced a frame: the car at its
   * authored pose while the physics world is still booting, so a drive that
   * takes over a live scene has its car on screen from the first commit. The
   * world's first frame replaces it; `null` clears it by hand. Nothing is
   * drawn once a frame has been shown. Returns the actor as drawn, lifted to
   * the ground like a frame's actors, or null when nothing was drawn.
   */
  standIn(actor: ActorRenderState | null): ActorRenderState | null;
  setFollow(actorId: string | null, mode?: 'chase' | 'dash'): void;
  dispose(): void;
}

export function createTruthViewerBridge(
  viewer: CityViewer,
  opts: TruthViewerBridgeOptions = {},
): TruthViewerBridge {
  const layer = opts.layer ?? 'live-world';
  const standInLayer = `${layer}:stand-in`;
  const shouldGroundLift = opts.groundLift ?? true;
  const adapter = new ThreeRendererAdapter(viewer);
  const sampleGround = indexedWorldHeightSampler(viewer);
  const previousFrameHook = viewer.onFrame;
  const now = opts.now ?? (() => performance.now());
  const clock = new SnapshotClock(opts.clock);
  /**
   * Frames not yet drawn past, oldest first. The world posts every fixed step,
   * so this holds the few steps between the render clock and the newest.
   */
  const buffered: TruthFrame[] = [];
  /**
   * Distance each actor has travelled at each received step (Σ signed v·dt over
   * steps it was present on, the render timeline's `wheelSpinRad` rule). It
   * phases ridden two-wheelers' pedals and wheels by distance, not clock.
   */
  const odometers = new WeakMap<TruthFrame, ReadonlyMap<string, number>>();
  let latest: TruthFrame | null = null;
  let drawnOnce = false;
  let followId: string | null = null;
  let followMode: 'chase' | 'dash' = 'chase';
  let disposed = false;
  let lastRendered = new Map<string, ActorRenderState>();
  let standInShown = false;
  const appearance = new Map<string, { catalogId: string; authored: boolean }>();

  const appearanceOf = (actorId: string, actorClass: TruthFrame['actors'][number]['class']) => {
    const cached = appearance.get(actorId);
    if (cached) return cached;
    const authoredId = opts.authoredCatalogId?.(actorId) ?? null;
    if (authoredId !== null) getEntry(authoredId); // throws on an unknown authored asset
    const resolved = authoredId !== null
      ? { catalogId: authoredId, authored: true }
      : { catalogId: catalogIdFor(actorClass), authored: false };
    appearance.set(actorId, resolved);
    return resolved;
  };

  viewer.scene.add(adapter.actors.group);

  let failed: Error | null = null;
  const render = (): void => {
    if (disposed || !latest || failed) return;
    try {
      renderAt(clock.advance(now() / 1000) ?? latest.timeSec);
    } catch (error) {
      // An authored asset the catalog does not know is a document error, not
      // something to paper over with a generic body. Stop rendering frames and
      // say so once; a new source (new bridge) starts clean.
      failed = error instanceof Error ? error : new Error(String(error));
      opts.onError?.(failed);
      if (!opts.onError) throw failed;
    }
  };

  /**
   * Draw the world as it was at sim time `timeS`, blended between the two
   * buffered steps either side of it. Positions blend linearly and headings
   * along the shorter arc; an actor present only in the later step is drawn
   * where that step has it.
   */
  const renderAt = (timeS: number): void => {
    const bracket = bracketSnapshots(buffered, (frame) => frame.timeSec, timeS);
    if (!bracket) return;
    const { from, to, alpha } = bracket;
    // Steps before `from` can never be drawn again: the clock only moves forward.
    const drawnPast = buffered.indexOf(from);
    if (drawnPast > 0) buffered.splice(0, drawnPast);
    const priorActors = from === to ? null : sceneActors(from);
    const metadata = new Map(to.actors.map((actor) => [actor.id, actor]));
    const groundReady = shouldGroundLift && viewer.getGroundIndex() !== null;
    const actors: ActorRenderState[] = [];

    for (const current of to.scene.actors) {
      if (current.kind === 'despawn') continue;
      const meta = metadata.get(current.id);
      if (!meta) continue;
      const prior = priorActors?.get(current.id);
      const x = prior ? lerp(prior.position[0], current.position[0], alpha) : current.position[0];
      const z = prior ? lerp(prior.position[2], current.position[2], alpha) : current.position[2];
      const headingRad = prior ? lerpAngle(prior.yawRad, current.yawRad, alpha) : current.yawRad;
      const y = groundReady ? sampleGround(x, z) ?? current.position[1] : current.position[1];
      const look = appearanceOf(current.id, meta.class);
      const odometerNow = odometers.get(to)?.get(current.id);
      const odometerPrior = from === to ? undefined : odometers.get(from)?.get(current.id);
      actors.push({
        id: current.id,
        catalogId: look.catalogId,
        catalogIdAuthored: look.authored,
        x,
        y,
        z,
        headingRad,
        dims: meta.dims,
        kind: renderKindFor(meta.class),
        speedMps: Math.hypot(current.velocity[0], current.velocity[2]),
        ...(odometerNow === undefined
          ? {}
          : { odometerM: odometerPrior === undefined ? odometerNow : lerp(odometerPrior, odometerNow, alpha) }),
      });
    }

    if (disposed) return;
    adapter.applyActorFrame({
      contractVersion: adapter.contractVersion,
      layer,
      tick: to.tick,
      timeS,
      actors,
    });
    drawnOnce = true;
    lastRendered = new Map(actors.map((actor) => [actor.id, actor]));
    clearStandIn();
    if (followId) applyFollow();
  };

  // Actors are only ever moved here, once per displayed frame, so the car and
  // the camera that follows it are always written from the same moment.
  const frameHook = (dt: number): void => {
    previousFrameHook?.(dt);
    render();
  };
  viewer.onFrame = frameHook;

  const applyFollow = (): void => {
    if (!followId || disposed) return;
    const actor = lastRendered.get(followId);
    if (!actor) return;
    const pose = followCameraPose(actor, followMode, actorOrigin(actor));
    viewer.controls.applyView({
      position: pose.position,
      target: pose.target,
      fov: viewer.camera.fov,
    });
  };

  const clearStandIn = (): void => {
    if (!standInShown) return;
    standInShown = false;
    adapter.actors.clearLayer(standInLayer);
  };

  return {
    actors: adapter.actors,
    apply(frame) {
      if (disposed) return;
      if (latest && frame.tick <= latest.tick) return;
      const previous = latest ? odometers.get(latest) : undefined;
      const dt = latest ? frame.timeSec - latest.timeSec : 0;
      const distances = new Map<string, number>();
      for (const actor of frame.scene.actors) {
        if (actor.kind === 'despawn') continue;
        const before = previous?.get(actor.id);
        // Signed like the timeline's speed: velocity against the body's
        // heading (yaw CCW from +X about +Y) runs the odometer back.
        const along = actor.velocity[0] * Math.cos(actor.yawRad) - actor.velocity[2] * Math.sin(actor.yawRad);
        const speed = Math.hypot(actor.velocity[0], actor.velocity[1], actor.velocity[2]);
        distances.set(actor.id, before === undefined ? 0 : before + (along < 0 ? -speed : speed) * dt);
      }
      odometers.set(frame, distances);
      latest = frame;
      buffered.push(frame);
      // A world that stops being drawn (suspended viewer) must not grow this
      // without bound; a second of steps is far more than the clock ever lags.
      if (buffered.length > MAX_BUFFERED_FRAMES) buffered.splice(0, buffered.length - MAX_BUFFERED_FRAMES);
      clock.observe(frame.timeSec, now() / 1000);
      if (!drawnOnce) render();
    },
    rendered(actorId) {
      return lastRendered.get(actorId) ?? null;
    },
    standIn(actor) {
      if (disposed || !actor || latest) {
        clearStandIn();
        return null;
      }
      const groundReady = shouldGroundLift && viewer.getGroundIndex() !== null;
      const drawn = { ...actor, y: groundReady ? sampleGround(actor.x, actor.z) ?? actor.y : actor.y };
      adapter.applyActorFrame({
        contractVersion: adapter.contractVersion,
        layer: standInLayer,
        tick: -1,
        timeS: 0,
        actors: [drawn],
      });
      standInShown = true;
      return drawn;
    },
    reset() {
      if (disposed) return;
      latest = null;
      buffered.length = 0;
      clock.reset();
      drawnOnce = false;
      failed = null;
      appearance.clear();
      lastRendered.clear();
      adapter.actors.clearLayer(layer);
    },
    setFollow(actorId, mode = 'chase') {
      if (disposed) return;
      followId = actorId;
      followMode = mode;
      viewer.controls.setEnabled(actorId === null);
      if (actorId) applyFollow();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      followId = null;
      viewer.controls.setEnabled(true);
      if (viewer.onFrame === frameHook) viewer.onFrame = previousFrameHook;
      clearStandIn();
      adapter.actors.clearLayer(layer);
      adapter.actors.dispose();
      latest = null;
      buffered.length = 0;
      lastRendered.clear();
    },
  };
}

/** Steps kept for interpolation: about two seconds of a 20 ms world. */
const MAX_BUFFERED_FRAMES = 128;


type SceneActor = TruthFrame['scene']['actors'][number];
/** A frame is blended from for several displayed frames; index its actors once. */
const sceneActorIndex = new WeakMap<TruthFrame, Map<string, SceneActor>>();

function sceneActors(frame: TruthFrame): Map<string, SceneActor> {
  let index = sceneActorIndex.get(frame);
  if (!index) {
    index = new Map(frame.scene.actors.filter((actor) => actor.kind !== 'despawn').map((actor) => [actor.id, actor]));
    sceneActorIndex.set(frame, index);
  }
  return index;
}

function catalogIdFor(actorClass: TruthFrame['actors'][number]['class']): string {
  switch (actorClass) {
    case 'truck': return 'vehicle.box_truck';
    case 'bus': return 'vehicle.bus';
    case 'motorcycle': return 'vehicle.motorcycle';
    case 'bicycle': return 'vehicle.bicycle';
    case 'pedestrian': return 'pedestrian.adult';
    case 'prop': return 'object.cone';
    default: return 'vehicle.sedan';
  }
}

function renderKindFor(actorClass: TruthFrame['actors'][number]['class']): ActorRenderState['kind'] {
  return actorClass === 'prop' ? 'static_object' : actorClass;
}
