import { competingMotionInteractions } from "@simforge-oss/editor";
import { instantiateSensorRig, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

const DRIVER_SENSOR_RIG_ID = "basic-dash-camera";
const DRIVABLE_CLASSES: Record<string, true> = { car: true, truck: true, bus: true, van: true, motorcycle: true };
type Role = ScenarioTemplateV2["roles"][number];

export type DriverRoleResolution =
  | { readonly ok: true; readonly roleId: string }
  | { readonly ok: false; readonly reason: string };

function drivable(role: Role): boolean {
  return role.kind === "scene_absolute" && DRIVABLE_CLASSES[role.actor.class] === true;
}

export function resolveDriverRole(template: ScenarioTemplateV2, requestedRoleId?: string): DriverRoleResolution {
  if (!template.anchor.pin) return { ok: false, reason: "This scenario is not pinned to a map site, so a recorded drive could not be replayed on it. Pin it in the editor first." };
  const candidates = template.roles.filter(drivable);
  if (requestedRoleId !== undefined) {
    const requested = template.roles.find((role) => role.id === requestedRoleId);
    if (!requested) return { ok: false, reason: `This scenario has no actor "${requestedRoleId}".` };
    if (!drivable(requested)) return { ok: false, reason: `"${requested.label ?? requested.id}" is a ${requested.actor.class} placed in the ${requested.kind} frame, which a person cannot drive.` };
    return { ok: true, roleId: requested.id };
  }
  if (candidates.length === 0) return { ok: false, reason: "This scenario has no drivable vehicle to take over." };
  const declared = candidates.filter((role) => role.id === template.metricSubject);
  if (declared.length === 1) return { ok: true, roleId: declared[0]!.id };
  if (candidates.length === 1) return { ok: true, roleId: candidates[0]!.id };
  return { ok: false, reason: `This scenario has ${candidates.length} drivable vehicles and no declared subject. Choose the actor to drive.` };
}

export function driverInTheLoopContent(template: ScenarioTemplateV2, roleId: string): ScenarioTemplateV2 {
  const role = template.roles.find((candidate) => candidate.id === roleId);
  if (!role) throw new Error(`Cannot prepare a drive for missing actor "${roleId}".`);
  const displaced = new Set(competingMotionInteractions(template.choreography.interactions, roleId).map((interaction) => interaction.id));
  const sensors = role.actor.sensors.length > 0 ? null : instantiateSensorRig("basic-dash-camera", { class: role.actor.class, ...(role.actor.dims === undefined ? {} : { dims: role.actor.dims }) });
  if (sensors === null && displaced.size === 0) return template;
  return {
    ...template,
    ...(displaced.size === 0 ? {} : { choreography: { ...template.choreography, interactions: template.choreography.interactions.filter((interaction) => !displaced.has(interaction.id)) } }),
    ...(sensors === null ? {} : { roles: template.roles.map((candidate) => candidate.id === roleId ? { ...candidate, actor: { ...candidate.actor, sensors } } : candidate) }),
  };
}

export function driverInTheLoopTitle(baseTitle: string, existingTitles: readonly string[]): string {
  const stem = `${baseTitle} — Driver in the loop`;
  const taken = new Set(existingTitles);
  if (!taken.has(stem)) return stem.slice(0, 200);
  for (let n = 2; ; n += 1) { const candidate = `${stem} ${n}`; if (!taken.has(candidate)) return candidate.slice(0, 200); }
}
