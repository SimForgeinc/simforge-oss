/**
 * The base clip: an actor's baseline locomotion, expressed as the first clip on
 * its timeline rather than as a separate "navigation mode".
 *
 * ## Why this exists
 *
 * An actor used to be controlled from two places at once. `placement_mode` /
 * `autopilot` / `is_static` decided how it moved by default, and the behavior
 * timeline decided what it did over time. Those are the same question asked
 * twice, and they could disagree: authoring a `cruise` clip on an autopilot
 * actor produced a program the runtime read two ways, which is why
 * `claimAutopilotActorWithClip` had to silently flip `autopilot` off, and why
 * `runtime-submit-validation` rejects a longitudinal clip on a drive-by-points
 * actor at submit time instead of the editor preventing it.
 *
 * The fix is not to delete one surface — a timeline is inherently SPARSE, and
 * something must drive the actor at t=0 and between clips. It is to make the
 * baseline itself a clip. Every actor's program now opens with one, and the
 * timeline becomes the single place motion is authored.
 *
 * ## Explicit identity
 *
 * Normalized clips carry `role: "base"` or `role: "interaction"`. A program a
 * constructor hands over without markers resolves through the shape rule
 * (`isBaseClipShape`) once, then normalization stamps the resolved identity.
 *
 * ## Direction of compilation
 *
 * Clip -> placement (`placementFieldsFromBaseClip`). `placement_mode`,
 * `is_static` and `speed_kph` are outputs of the base clip, not things a user
 * edits; the runtime `autopilot` boolean is compiled at the payload boundary.
 */

import {
  ACTOR_ROUTE_ACTION_KINDS,
  DEFAULT_BEHAVIOR_CLIP_END,
  emptyActorBehaviorProgram,
  type ActorBehaviorProgram,
  type BehaviorAction,
  type BehaviorActionKind,
  type BehaviorClip,
} from "@simforge-oss/scenario/contracts";
import type { ScenarioEditorActorDraft } from "./scenario-editor";

/**
 * Actions that can serve as a baseline — the ones that answer "what is this
 * actor doing when nothing else is telling it otherwise".
 *
 * Deliberately narrow. A maneuver like `lane_change` or `stop` is an EVENT: it
 * completes and leaves the actor needing something else to do. Only these run
 * open-endedly, which is what a baseline has to do.
 */
const BASE_LOCOMOTION_ACTION_KINDS = [
  /** Traffic Manager drives it by lane rules. Needs a lane-anchored spawn. */
  "autopilot",
  /**
   * An autopilot intent compiled to explicit lane-graph geometry
   * (`compileAutopilotRoute`). Deterministic and exportable, where `autopilot`
   * is neither. Only ever created by that compile or authored outright —
   * `baseActionForDraft` does not derive it from placement.
   */
  "follow_route",
  /** Our controller holds a target speed along the lane. */
  "cruise",
  /** Drive by points: spacing is the speed. */
  "follow_path",
  /** Walk by points. */
  "walk_path",
  /** Parked: frozen at the authored pose. */
  "hold",
] as const satisfies readonly BehaviorActionKind[];

type BaseLocomotionActionKind =
  (typeof BASE_LOCOMOTION_ACTION_KINDS)[number];

function isBaseLocomotionAction(
  kind: BehaviorActionKind,
): kind is BaseLocomotionActionKind {
  return (BASE_LOCOMOTION_ACTION_KINDS as readonly BehaviorActionKind[]).includes(
    kind,
  );
}

/** The stable id every synthesized base clip gets, so edits are idempotent. */
const BASE_CLIP_ID_PREFIX = "bhv_base_";

export function baseClipId(actorId: string): string {
  return `${BASE_CLIP_ID_PREFIX}${actorId}`;
}

/** Locomotion whose geometry IS the actor's placement path. */
function isPathAction(kind: BehaviorActionKind): boolean {
  return kind === "follow_path" || kind === "walk_path";
}

/**
 * Locomotion whose geometry lives on the ACTOR rather than in the clip, and
 * which is therefore only legal as the baseline. Same list the schema refuses in
 * the interaction layer — imported rather than re-spelled so the two cannot say
 * different things.
 */
function isRouteAction(kind: BehaviorActionKind): boolean {
  return (ACTOR_ROUTE_ACTION_KINDS as readonly BehaviorActionKind[]).includes(kind);
}

/**
 * A clip qualifies as the baseline in one of two ways.
 *
 * The ordinary way is starting the scenario and running open-endedly. `t <= 0`
 * rather than `t === 0` because a baseline that starts before the scenario
 * starts is still the baseline.
 *
 * A PATH clip qualifies whatever its trigger, because its waypoints are the
 * actor's placement path and an actor has exactly one of those. The case that
 * forces this is the conflict walker: its crossing is authored as a `walk_path`
 * armed by `proximity` to the ego rather than by the clock (`crossWhenClip`).
 * That crossing is its baseline — it is the only motion the walker has.
 * Requiring `at_time` here would fail to see it and prepend a SECOND
 * `walk_path` at t=0, and the walker would step into the road immediately
 * instead of waiting for the car.
 */
function isBaseClipShape(clip: BehaviorClip): boolean {
  if (!isBaseLocomotionAction(clip.action.kind)) return false;
  if (isPathAction(clip.action.kind)) return true;
  return clip.trigger.kind === "at_time" && clip.trigger.t <= 0;
}

/** Index of the actor's base clip, or `-1` when its program has none. */
export function baseClipIndex(program: ActorBehaviorProgram): number {
  const explicitIndex = program.clips.findIndex((clip) => clip.role === "base");
  if (explicitIndex !== -1) return explicitIndex;
  return program.clips.findIndex(isBaseClipShape);
}

/** The actor's base clip, or `null` when its program has none. */
export function baseClip(program: ActorBehaviorProgram): BehaviorClip | null {
  const index = baseClipIndex(program);
  return index === -1 ? null : (program.clips[index] ?? null);
}

/**
 * True when this clip is the one the dock pins at t=0 and refuses to delete.
 * Identity, not shape: a SECOND locomotion clip at t=0 is an ordinary clip.
 */
export function isBaseClip(
  program: ActorBehaviorProgram,
  clipId: string,
): boolean {
  return baseClip(program)?.id === clipId;
}

// ---------------------------------------------------------------------------
// Synthesis: placement -> base clip
// ---------------------------------------------------------------------------

/**
 * The baseline a draft's placement describes.
 *
 * Walkers walk their points, path placements follow their points, parked
 * actors and props hold, and a road vehicle cruises at its authored speed.
 * That last default is deliberate and is the whole answer to "does a new car
 * start on Auto?": it does not, ever. Auto hands the car to CARLA's Traffic
 * Manager, which decides its own route — the one baseline an author cannot
 * predict, read off the screen, reproduce, or export to OpenSCENARIO. A
 * Traffic-Manager baseline is therefore only ever AUTHORED, by a constructor
 * that wants background traffic and says so with an explicit `autopilot`
 * action (`withBaseAction`); nothing derives it from placement.
 */
export function baseActionForDraft(draft: ScenarioEditorActorDraft): BehaviorAction {
  if (draft.is_static || draft.kind === "prop") return { kind: "hold" };

  const waypoints = draft.timed_waypoints ?? [];
  const onPath =
    draft.placement_mode === "timed_path" || draft.placement_mode === "path";

  if (draft.kind === "walker") {
    // A walker with no points is inert; `hold` says that honestly rather than
    // synthesizing an empty path the schema would reject (`min(1)`).
    return waypoints.length > 0
      ? {
          kind: "walk_path",
          waypoints: [...waypoints],
          ...(draft.speed_kph != null ? { speed_kph: draft.speed_kph } : {}),
        }
      : { kind: "hold" };
  }

  if (onPath) {
    return waypoints.length > 0
      ? {
          kind: "follow_path",
          waypoints: [...waypoints],
          timed: draft.placement_mode === "timed_path",
        }
      : { kind: "hold" };
  }

  return { kind: "cruise", speed_kph: draft.speed_kph ?? 0 };
}

/** The baseline clip a draft's placement describes, stamped `base`. */
function baseClipForDraft(draft: ScenarioEditorActorDraft): BehaviorClip {
  return {
    id: baseClipId(draft.id),
    enabled: true,
    role: "base",
    trigger: { kind: "at_time", t: 0 },
    end: DEFAULT_BEHAVIOR_CLIP_END,
    action: baseActionForDraft(draft),
  };
}

/**
 * Guarantee the program opens with a baseline, without disturbing one it
 * already has.
 *
 * Idempotent: an actor whose program already opens with a base-shaped clip
 * (every drive-by-points actor's `follow_path` / `walk_path`) is returned
 * untouched, because that clip already IS the baseline. Only actors whose
 * program says nothing about their baseline gain a clip here.
 */
function withBaseClip(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
): ActorBehaviorProgram {
  if (baseClipIndex(program) !== -1) return program;
  return { ...program, clips: [baseClipForDraft(draft), ...program.clips] };
}

/** Set (or introduce) the actor's baseline action, preserving clip identity. */
export function withBaseAction(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
  action: BehaviorAction,
): ActorBehaviorProgram {
  const index = baseClipIndex(program);
  if (index === -1) {
    return {
      ...program,
      clips: [{ ...baseClipForDraft(draft), action }, ...program.clips],
    };
  }
  return {
    ...program,
    clips: program.clips.map((clip, position) =>
      position === index ? { ...clip, action } : clip,
    ),
  };
}

// ---------------------------------------------------------------------------
// Compilation: base clip -> placement fields
// ---------------------------------------------------------------------------

/**
 * The compiled placement tuple the runtime reads. `placement_mode`,
 * `is_static` and `speed_kph` are declared draft fields; `autopilot` is NOT —
 * it is a boundary-only output the payload build spreads onto the wire actor.
 */
export type CompiledActorPlacementFields = Partial<
  Pick<ScenarioEditorActorDraft, "placement_mode" | "is_static" | "speed_kph">
> & {
  /** Compiled from the base clip; the wire still carries it. Never persisted. */
  autopilot?: boolean;
};

/**
 * The placement/control fields the worker still reads, derived from the base
 * clip. The inverse of `baseActionForDraft`.
 *
 * `spawn` provenance is deliberately NOT touched: where an actor sits is a
 * placement decision made on the map, and a lane-anchored actor stays
 * lane-anchored through every baseline change. The one exception is `hold`
 * arriving on a `timed_path` actor — that placement mode means "my position is
 * a function of time", which parking contradicts, so it falls back to `point`.
 */
export function placementFieldsFromBaseClip(
  draft: ScenarioEditorActorDraft,
): CompiledActorPlacementFields {
  const program = draft.behavior;
  const action = program ? baseClip(program)?.action : undefined;
  if (!action) return {};

  switch (action.kind) {
    case "autopilot":
      return {
        placement_mode: "road",
        autopilot: action.enabled,
        is_static: false,
        // Absent means "no opinion": keep whatever the draft carries rather
        // than compiling a 0 that the worker would hand the TM as a desired
        // speed of zero.
        ...(action.speed_kph != null ? { speed_kph: action.speed_kph } : {}),
      };
    case "cruise":
      return {
        placement_mode: "road",
        autopilot: false,
        is_static: false,
        speed_kph: action.speed_kph,
      };
    // A compiled route is lane-anchored and driven by our own controller. The
    // anchors themselves are NOT compiled back onto `draft.route`; the compile
    // action writes both together, and one-way flow is what keeps them from
    // drifting.
    case "follow_route":
      return { placement_mode: "road", autopilot: false, is_static: false };
    // Path geometry is deliberately NOT compiled back onto the draft. It flows
    // one way — map -> clip, via `withSyncedBasePath` — because the map is
    // where space is authored. The reverse direction is also unrepresentable:
    // a behavior waypoint's `time` is optional (an untimed path has none) while
    // a draft's `timed_waypoints` requires one, so compiling back would have to
    // invent arrival times.
    case "follow_path":
      return {
        placement_mode: action.timed ? "timed_path" : "path",
        autopilot: false,
        is_static: false,
      };
    case "walk_path":
      return {
        placement_mode: "timed_path",
        autopilot: false,
        is_static: false,
        ...(action.speed_kph != null ? { speed_kph: action.speed_kph } : {}),
      };
    case "hold": {
      // `hold` means two different things, told apart by whether the actor
      // still has a point list at all.
      //
      // An actor in drive-by-points mode that has no points drawn YET holds
      // because it has nowhere to go. It is not parked: it keeps its path
      // placement and stays non-static, so the first point the author drops
      // promotes it straight to `follow_path`. Compiling it to `is_static`
      // here would freeze a car the author is in the middle of routing, and
      // bounce the mode selector back to Parked between the click and the
      // first point.
      //
      // An actor with no list at all is genuinely parked. `timed_path` is the
      // one placement that cannot survive that, because it means "my position
      // is a function of time".
      const onPath =
        draft.placement_mode === "timed_path" || draft.placement_mode === "path";
      if (onPath && draft.timed_waypoints !== undefined) {
        return { autopilot: false, is_static: false };
      }
      return {
        placement_mode:
          draft.placement_mode === "timed_path" ? "point" : draft.placement_mode,
        autopilot: false,
        is_static: true,
        speed_kph: 0,
      };
    }
    default:
      // A non-locomotion action can never be the base clip (`isBaseClipShape`
      // gates on `isBaseLocomotionAction`), so there is nothing to compile.
      return {};
  }
}

/**
 * The draft with its compiled control fields recompiled from its base clip.
 *
 * `autopilot` is deliberately NOT written here: it is not a persisted field,
 * so writing it into every in-memory draft would only create a key the
 * serializers then have to strip. It is compiled where it is consumed, at the
 * runtime payload boundary, from `placementFieldsFromBaseClip`.
 */
export function withCompiledBaseClip(
  draft: ScenarioEditorActorDraft,
): ScenarioEditorActorDraft {
  const { autopilot: _autopilot, ...fields } = placementFieldsFromBaseClip(draft);
  return { ...draft, ...fields };
}

/**
 * Set the actor's commanded speed, writing it through to the base clip when the
 * baseline is one that carries a speed of its own.
 *
 * Without this, the detail panel's speed slider and a `cruise` baseline would be
 * the dual-authority problem in miniature: the slider writes `speed_kph`, the
 * recompile immediately overwrites it from the clip, and the control appears
 * not to work. Speed is motion, so the clip owns it and the slider is a second
 * view onto the same field.
 */
export function withBaseSpeed(
  draft: ScenarioEditorActorDraft,
  speedKph: number,
): ScenarioEditorActorDraft {
  const next: ScenarioEditorActorDraft = { ...draft, speed_kph: speedKph };
  const current = next.behavior ? baseClip(next.behavior) : null;
  if (!current) return next;
  const action = current.action;
  // `autopilot` is deliberately absent even though it CAN carry a speed. Its
  // speed is opt-in (`baseActionForDraft` never seeds one) precisely so
  // `draft.speed_kph` stays writable; letting this helper claim it would hand
  // ownership to the clip behind the author's back and start clobbering the
  // very writes the omission protects.
  if (action.kind !== "cruise" && action.kind !== "walk_path") return next;
  return withCompiledBaseClip({
    ...next,
    behavior: withBaseAction(next.behavior!, next, {
      ...action,
      speed_kph: speedKph,
    }),
  });
}

/**
 * Re-derive the base action when the actor's PATH is the thing that moved.
 *
 * Geometry is authored on the map, not in the dock — the runtime requires a
 * `follow_path` clip's waypoints to equal the actor's placement path, which is
 * why the inspector renders them read-only (`MAP_AUTHORED_ACTION_KINDS`). So
 * the split is: the clip owns HOW the actor moves, `timed_waypoints` owns
 * WHERE. Whenever the actor is on a path placement, the clip's copy of the
 * geometry is refreshed from the draft rather than the other way round.
 *
 * This is also what promotes a freshly placed drive-by-points car off `hold`:
 * it has no points yet (and `walk_path`/`follow_path` require at least one), so
 * its baseline starts as a truthful "not going anywhere" and becomes a path the
 * moment the first point lands.
 */
function withSyncedBasePath(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
): ActorBehaviorProgram {
  const current = baseClip(program);
  const onPath =
    draft.placement_mode === "timed_path" || draft.placement_mode === "path";
  const wasPath =
    current?.action.kind === "follow_path" || current?.action.kind === "walk_path";
  if (!onPath && !wasPath) return program;
  return withBaseAction(program, draft, baseActionForDraft(draft));
}

/**
 * Rewrite a route action that is NOT the baseline into the speed command it
 * actually is.
 *
 * `ActorBehaviorProgramSchema` refuses a route action in the interaction layer:
 * its geometry lives on the actor, so only the base clip may carry it. Stamping
 * roles without honouring that rule is how normalization came to emit drafts its
 * own schema rejects — and because the load path dropped what it could not
 * parse, the actor then disappeared from the editor and the next save deleted it
 * from the database. Measured 2026-07-29: eval scenario
 * `68b1d66e-c43f-4c3b-9f29-446f4443b2ea` persisted with its second car gone,
 * 125 more drafts in dev carrying the same shape.
 *
 * The rewrite is `cruise`, because that is what these clips already do. In BOTH
 * runtimes a non-base `follow_route` sets the commanded speed and clears the
 * stop flag (`applyTimelineClipAction`, `_tick_follow_route`), and a non-base
 * `follow_path` / `walk_path` does the same and lets the path controller resume
 * (`releaseToPlacementPath`, `_begin_follow_path`) — neither re-routes anything,
 * because the polyline was resolved at spawn from the ACTOR. A cruise at the
 * same speed issues the same command.
 *
 * Two differences, both deliberate and both recorded here rather than hidden:
 *
 * - `cruise` has a completion probe and the route actions do not, so a clip
 *   ending on `completion` now ends when the actor reaches the speed instead of
 *   never ending. Anything chained `after_clip` on it was therefore waiting on a
 *   clip that could not end — a dead chain that now fires. The clip ID is
 *   preserved so the chain still resolves.
 * - A route action's speed is optional and a cruise's is required, so the
 *   actor's own commanded speed is used when the clip named none. For a path
 *   actor that IS the speed it was already driving.
 */
function withRouteActionsInTheBaseSlotOnly(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
  baseIndex: number,
): ActorBehaviorProgram {
  const offenders = program.clips.some(
    (clip, index) => index !== baseIndex && isRouteAction(clip.action.kind),
  );
  if (!offenders) return program;
  return {
    ...program,
    clips: program.clips.map((clip, index) => {
      if (index === baseIndex || !isRouteAction(clip.action.kind)) return clip;
      const speedKph =
        ("speed_kph" in clip.action ? clip.action.speed_kph : undefined) ??
        draft.speed_kph ??
        0;
      return { ...clip, action: { kind: "cruise", speed_kph: speedKph } };
    }),
  };
}

/**
 * Give a draft a baseline, sync its path geometry, and recompile its placement
 * fields from the result. The normalization entry point.
 *
 * Idempotent by construction, which matters because it runs on every actor on
 * every edit: normalizing an already-normalized draft is a no-op, so nothing
 * drifts and no edit fights the previous one.
 *
 * Its output is also SCHEMA-LEGAL by construction — `ActorBehaviorProgramSchema`
 * accepts everything this returns. That is not a nicety: the load path parses
 * before it normalizes, so a normalization that emits an illegal draft makes the
 * actor unparseable the next time the scenario is opened, and the actor is lost.
 * `base-clip-normalization-round-trip.test.ts` pins it over the whole corpus.
 */
export function normalizeActorBaseClip(
  draft: ScenarioEditorActorDraft,
): ScenarioEditorActorDraft {
  const resolvedProgram = withSyncedBasePath(
    withBaseClip(draft.behavior ?? emptyActorBehaviorProgram(), draft),
    draft,
  );
  const baseIndex = baseClipIndex(resolvedProgram);
  // Before the roles are stamped, not after: stamping `interaction` on a route
  // action is precisely what makes the program illegal.
  const legalProgram = withRouteActionsInTheBaseSlotOnly(
    resolvedProgram,
    draft,
    baseIndex,
  );
  const rolesAreStamped = legalProgram.clips.every(
    (clip, index) =>
      clip.role === (index === baseIndex ? "base" : "interaction"),
  );
  const program = rolesAreStamped
    ? legalProgram
    : {
        ...legalProgram,
        clips: legalProgram.clips.map((clip, index) => ({
          ...clip,
          role: index === baseIndex ? "base" as const : "interaction" as const,
        })),
      };
  return withCompiledBaseClip({ ...draft, behavior: program });
}
