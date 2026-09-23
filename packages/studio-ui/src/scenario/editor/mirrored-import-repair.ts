import {
  detectMirroredOpenScenarioImport,
  fixMirroredOpenScenarioImport,
  OPENSCENARIO_IMPORT_EXTENSION_KEY,
  type MirroredImportSkippedRole,
  type ScenarioTemplateV2,
} from "@simforge-oss/scenario";
import type { EditorDocument } from "@simforge-oss/editor";

/** The slice of the editor document the repair reads and writes. */
export type RepairableDocument = Pick<EditorDocument, "data" | "applyRepair">;

export type MirroredImportBannerModel = {
  /** Imported roles the repair would move, in document order. */
  readonly roleIds: readonly string[];
  /**
   * Imported roles left where they are because the author moved them onto a
   * lane or gave them a route after importing. Roles the author added, or whose
   * kind they changed, are not listed: they were never at a mirrored pose, or
   * no longer have one.
   */
  readonly keptEdited: readonly MirroredImportSkippedRole[];
};

const EDITED_AFTER_IMPORT = new Set<MirroredImportSkippedRole["reason"]>([
  "lane_anchored",
  "has_initial_route",
  "has_route_interaction",
]);

/**
 * What the "Fix mirrored positions" banner offers for this document, or `null`
 * when it has nothing to offer: never imported, already repaired, imported by
 * the fixed importer, nothing left to move, or too ambiguous to fix without a
 * person looking at the data (see `detectMirroredOpenScenarioImport`).
 */
export function mirroredImportBannerModel(data: ScenarioTemplateV2 | null | undefined): MirroredImportBannerModel | null {
  if (!data) return null;
  const detection = detectMirroredOpenScenarioImport(data);
  if (detection.status !== "affected") return null;
  return {
    roleIds: detection.flips.map((flip) => flip.id),
    keptEdited: detection.skipped.filter((role) => EDITED_AFTER_IMPORT.has(role.reason)),
  };
}

/**
 * Apply the repair to the open document as one undoable edit. The editor's
 * normal autosave then PATCHes the draft with its `expectedVersion`, so the
 * server stores it as the next draft version. Returns whether anything changed.
 */
export function applyMirroredImportRepair(document: RepairableDocument, now: Date = new Date()): boolean {
  const result = fixMirroredOpenScenarioImport(document.data, now);
  if (!result.changed) return false;
  const moved = new Set(result.marker.roles);
  document.applyRepair({
    roles: result.document.roles.filter((role) => moved.has(role.id)),
    extensions: { [OPENSCENARIO_IMPORT_EXTENSION_KEY]: result.document.extensions?.[OPENSCENARIO_IMPORT_EXTENSION_KEY] },
  });
  return true;
}
