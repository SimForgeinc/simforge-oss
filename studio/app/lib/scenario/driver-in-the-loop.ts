/**
 * Driver in the loop: preparing the variation a human drives.
 *
 * A Driver in the Loop variation is an ordinary scenario document with an
 * ordinary parent pointer. The only things this module decides are which actor
 * the human takes over and whether that actor can produce a renderable clip,
 * because both have to be answered on the server — before the variation exists
 * — so that a refusal is a 409 with a reason rather than a dead drive screen.
 */

import { competingMotionInteractions } from "@simforge-oss/editor";
import {
  instantiateSensorRig,
  type ScenarioTemplateV2,
} from "@simforge-oss/scenario";

/**
 * The rig a driven actor gets when it has none.
 *
 * A dash camera is the cheapest rig that makes the variation renderable, and
 * the render action in the scenario list is disabled without one, so a
 * variation created for driving would otherwise be born un-renderable.
 */
const DRIVER_SENSOR_RIG_ID = "basic-dash-camera";

/** Actor classes a person can drive. Pedestrians and props are not offered. */
const DRIVABLE_CLASSES: Record<string, true> = {
  car: true,
  truck: true,
  bus: true,
  van: true,
  motorcycle: true,
};
type Role = ScenarioTemplateV2["roles"][number];

export type DriverRoleResolution =
  | { readonly ok: true; readonly roleId: string }
  | { readonly ok: false; readonly reason: string };

function drivable(role: Role): boolean {
  // `manualDrive` is only legal on a pinned scene-frame role: the recording is
  // scene coordinates, so a frame-bound role cannot replay it. The compiler
  // rejects that combination, which would surface as a failed render long after
  // the drive — refuse it here instead.
  return role.kind === "scene_absolute" && DRIVABLE_CLASSES[role.actor.class] === true;
}

/**
 * Which actor the human takes over: the requested role, else the scenario's
 * ego, else its only drivable vehicle. An ambiguous scenario is refused rather
 * than guessed at, because driving the wrong car wastes the whole take.
 */
export function resolveDriverRole(
  template: ScenarioTemplateV2,
  requestedRoleId?: string,
): DriverRoleResolution {
  if (!template.anchor.pin) {
    return {
      ok: false,
      reason:
        "This scenario is not pinned to a map site, so a recorded drive could not be replayed on it. Pin it in the editor first.",
    };
  }
  const candidates = template.roles.filter(drivable);
  if (requestedRoleId !== undefined) {
    const requested = template.roles.find((role) => role.id === requestedRoleId);
    if (!requested) return { ok: false, reason: `This scenario has no actor "${requestedRoleId}".` };
    if (!drivable(requested)) {
      return {
        ok: false,
        reason: `"${requested.label ?? requested.id}" is a ${requested.actor.class} placed in the ${requested.kind} frame, which a person cannot drive.`,
      };
    }
    return { ok: true, roleId: requested.id };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: "This scenario has no drivable vehicle to take over." };
  }
  // `metricSubject` is the scenario's declared measurement subject — the actor a
  // drive should default to when the scenario names one.
  const declared = candidates.filter((role) => role.id === template.metricSubject);
  if (declared.length === 1) return { ok: true, roleId: declared[0]!.id };
  if (candidates.length === 1) return { ok: true, roleId: candidates[0]!.id };
  return {
    ok: false,
    reason: `This scenario has ${candidates.length} drivable vehicles and no declared subject. Choose the actor to drive.`,
  };
}

/**
 * The variation's content: the base scenario with a sensor rig guaranteed on
 * the driven actor and that actor's authored motion already displaced.
 *
 * The rig is there because the render action is disabled without a sensor
 * profile, so a variation created for driving would otherwise be born
 * un-renderable.
 *
 * The motion has to go *here*, before the drive, not when the take is saved.
 * `replaceActorMotion` does displace it on save — but the world the human
 * drives is compiled from this content, so an authored route left on the
 * driven actor is compiled into the drive: the engine spawns the actor at that
 * route's implied velocity and keeps the route as a second claim on the same
 * body. On a scenario whose route steps 167 m per second that is a van handed
 * to the driver at 620 km/h, which then spins out and slides for the rest of
 * the clip no matter what the human does. Every other actor keeps its
 * choreography; the driver's take is the only motion being replaced.
 */
export function driverInTheLoopContent(
  template: ScenarioTemplateV2,
  roleId: string,
): ScenarioTemplateV2 {
  const role = template.roles.find((candidate) => candidate.id === roleId);
  if (!role) throw new Error(`Cannot prepare a drive for missing actor "${roleId}".`);
  const displaced = new Set(
    competingMotionInteractions(template.choreography.interactions, roleId).map(
      (interaction) => interaction.id,
    ),
  );
  const sensors = role.actor.sensors.length > 0
    ? null
    : instantiateSensorRig(DRIVER_SENSOR_RIG_ID, {
        class: role.actor.class,
        ...(role.actor.dims === undefined ? {} : { dims: role.actor.dims }),
      });
  if (sensors === null && displaced.size === 0) return template;
  return {
    ...template,
    ...(displaced.size === 0
      ? {}
      : {
          choreography: {
            ...template.choreography,
            interactions: template.choreography.interactions.filter(
              (interaction) => !displaced.has(interaction.id),
            ),
          },
        }),
    ...(sensors === null
      ? {}
      : {
          roles: template.roles.map((candidate) =>
            candidate.id === roleId
              ? { ...candidate, actor: { ...candidate.actor, sensors } }
              : candidate,
          ),
        }),
  };
}

/** `Base — Driver in the loop`, numbered when the workspace already has one. */
export function driverInTheLoopTitle(baseTitle: string, existingTitles: readonly string[]): string {
  const stem = `${baseTitle} — Driver in the loop`;
  const taken = new Set(existingTitles);
  if (!taken.has(stem)) return stem.slice(0, 200);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate)) return candidate.slice(0, 200);
  }
}
