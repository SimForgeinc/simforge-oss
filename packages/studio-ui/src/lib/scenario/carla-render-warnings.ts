import { builtInActorCatalogResolver } from "@simforge-oss/compiler";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import {
  carlaCompatibilityFor,
  type CarlaCompatibilityTable,
} from "./carla-compatibility";

export type CarlaRenderWarning = Readonly<{
  kind: "drop" | "substitute";
  actorId: string;
  actorLabel: string;
  authoredCatalogId: string;
  substituteCatalogId?: string;
  reason: string;
}>;

/** Classes the CARLA executor cannot actuate: moving ones are dropped from execution. */
const UNACTUATED_CLASSES: Record<string, true> = {
  animal: true,
  drone: true,
  sidewalk_robot: true,
};

/** Road users the CARLA executor rebinds to the nearest same-class native body instead of failing. */
const ROAD_USER_CLASSES: Record<string, true> = {
  vehicle: true,
  car: true,
  truck: true,
  bus: true,
  van: true,
  motorcycle: true,
  bicycle: true,
  scooter: true,
  pedestrian: true,
};

/**
 * The nearest same-class catalog model with a native CARLA binding, ranked the way the CARLA
 * executor ranks its fallback: footprint distance (|Δlength| + |Δwidth|) first, catalog id second.
 */
function nearestNativeSameClass(
  authoredCatalogId: string,
  actorClass: string,
  table: CarlaCompatibilityTable,
): string | null {
  const authored = builtInActorCatalogResolver(authoredCatalogId);
  let best: { distance: number; catalogId: string } | null = null;
  for (const catalogId of Object.keys(table.native)) {
    const entry = builtInActorCatalogResolver(catalogId);
    if (!entry || (entry.actorClass ?? entry.class) !== actorClass) continue;
    const distance = authored
      ? Math.abs(entry.dims.l - authored.dims.l) + Math.abs(entry.dims.w - authored.dims.w)
      : Number.POSITIVE_INFINITY;
    if (
      best === null
      || distance < best.distance
      || (distance === best.distance && catalogId.localeCompare(best.catalogId) < 0)
    ) {
      best = { distance, catalogId };
    }
  }
  return best?.catalogId ?? null;
}

/**
 * Explain the same class-preserving fallback/drop decisions the CARLA executor makes,
 * before a CARLA render is submitted. These diagnostics are advisory only.
 */
export function carlaRenderWarnings(
  content: ScenarioTemplateV2 | null,
  table: CarlaCompatibilityTable,
): CarlaRenderWarning[] {
  if (!content) return [];

  return content.roles.flatMap((role): CarlaRenderWarning[] => {
    const authoredCatalogId = role.actor.catalogId?.trim() || "(unbound actor)";
    const actorLabel = role.label?.trim() || role.id;
    const actorClass = String(role.actor.class ?? "");
    const compatibility = carlaCompatibilityFor(authoredCatalogId, table);

    if (UNACTUATED_CLASSES[actorClass]) {
      return [{
        kind: "drop",
        actorId: role.id,
        actorLabel,
        authoredCatalogId,
        reason: actorClass === "animal"
          ? "CARLA cannot actuate moving animals; this actor will not run."
          : `CARLA cannot actuate moving ${actorClass.replaceAll("_", " ")} actors; this actor will not run.`,
      }];
    }

    if (compatibility.status === "native") return [];
    const staticActor = role.actor.static === true || actorClass === "static_object";
    if (ROAD_USER_CLASSES[actorClass]) {
      const substituteCatalogId = nearestNativeSameClass(authoredCatalogId, actorClass, table);
      if (substituteCatalogId) {
        return [{
          kind: "substitute",
          actorId: role.id,
          actorLabel,
          authoredCatalogId,
          substituteCatalogId,
          reason: "No native binding exists; CARLA will use the nearest same-class body.",
        }];
      }
    } else if (staticActor) {
      const catalogClass = authoredCatalogId.split(".", 1)[0];
      const substituteCatalogId = Object.keys(table.native)
        .filter((catalogId) => catalogId.startsWith(`${catalogClass}.`))
        .sort((left, right) => left.localeCompare(right))[0];
      if (substituteCatalogId) {
        return [{
          kind: "substitute",
          actorId: role.id,
          actorLabel,
          authoredCatalogId,
          substituteCatalogId,
          reason: "No native binding exists; CARLA will use a same-class prop counterpart.",
        }];
      }
    }
    return [{
      kind: "drop",
      actorId: role.id,
      actorLabel,
      authoredCatalogId,
      reason: staticActor
        ? `No same-class native CARLA prop is available. ${compatibility.reason}`
        : `No same-class CARLA counterpart is available. ${compatibility.reason}`,
    }];
  });
}
