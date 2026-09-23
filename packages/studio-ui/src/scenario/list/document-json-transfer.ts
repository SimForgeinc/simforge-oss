import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { ScenarioMapBinding, ScenarioMapVersionIdentityDto } from "@simforge-oss/studio-host";

/**
 * Download and import a document as JSON.
 *
 * v1's equivalent guessed a display name and a map out of eight candidate spellings each
 * (`mapAssetId`, `map_asset_id`, `setup.map.mapName`, …) because its `draft_json` had no schema. v2
 * has one: `parseTemplate` either returns a valid `ScenarioTemplateV2` or throws, so the import path
 * is a validation, not an excavation.
 *
 * OpenSCENARIO import is NOT here and is not coming — it is an explicit drop (§0.5 D1). This is
 * `ScenarioTemplateV2` in and out only.
 */

export type ScenarioDocumentTransferFile = {
  /** Marks the file as ours and pins the shape a future reader should expect. */
  simforgeScenarioExport: 1;
  title: string;
  /** Authored geometry provenance, resolved against the target's current source publication. */
  mapVersionId: string | null;
  mapSourceMapId?: string | null;
  mapXodrSha256?: string | null;
  exportedAt: string;
  content: ScenarioTemplateV2;
};

export class ScenarioImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioImportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function documentJsonFilename(title: string) {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${base}-${timestamp}.json`;
}

export function buildDocumentTransferFile(document: ScenarioMapBinding & {
  title: string;
  content: ScenarioTemplateV2;
}): ScenarioDocumentTransferFile {
  return {
    simforgeScenarioExport: 1,
    title: document.title,
    mapVersionId: document.mapVersionId,
    mapSourceMapId: document.mapSourceMapId,
    mapXodrSha256: document.mapXodrSha256,
    exportedAt: new Date().toISOString(),
    content: document.content,
  };
}

export function downloadDocumentJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Read an import file into a create payload.
 *
 * The wrapper carries canonical source identity and authored geometry provenance.
 * A bare template cannot prove its geometry version and is not silently retargeted.
 */
export function readDocumentTransferFile(input: unknown): ScenarioMapBinding & {
  title: string;
  content: ScenarioTemplateV2;
} {
  if (!isRecord(input)) {
    throw new ScenarioImportError("Scenario JSON must be a JSON object.");
  }
  const wrapped = isRecord(input.content) ? input.content : input;
  let content: ScenarioTemplateV2;
  try {
    content = parseTemplate(wrapped);
  } catch (parseError) {
    throw new ScenarioImportError(
      `That file is not a valid Scenario template: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`,
    );
  }
  const declaredTitle = typeof input.title === "string" ? input.title.trim() : "";
  const title = declaredTitle || content.meta.name?.trim() || "Imported Scenario";
  const mapVersionId =
    typeof input.mapVersionId === "string" && input.mapVersionId.trim()
      ? input.mapVersionId.trim()
      : null;
  return {
    title: title.slice(0, 200), content, mapVersionId,
    mapSourceMapId: typeof input.mapSourceMapId === "string" ? input.mapSourceMapId : (mapVersionId ? null : content.sourceMap?.mapId ?? null),
    mapXodrSha256: typeof input.mapXodrSha256 === "string" ? input.mapXodrSha256 : null,
  };
}

type ImportMapCandidate = { mapVersionId: string; sourceMapId: string; label: string; artifacts?: { xodrSha256: string } };

/**
 * Why an import can't bind to the version it was authored on, and the one
 * explicit alternative (if any). `transferTarget` is a newer installed
 * publication of the same source map with identical OpenDRIVE: importing
 * onto it is a transfer the user must choose, never a silent substitution.
 */
export class ScenarioImportMapError extends ScenarioImportError {
  constructor(
    message: string,
    readonly requestedMapVersionId: string | null,
    readonly transferTarget: ImportMapCandidate | null,
  ) {
    super(message);
    this.name = "ScenarioImportMapError";
  }
}

/**
 * The map version an imported file binds to: EXACTLY the one it was exported
 * from (`mapVersionId`, verified by the OpenDRIVE sha the file declares), when
 * that version exists here, whether or not it is the newest publication.
 * Otherwise it fails with a clear message; a same-source publication with
 * identical OpenDRIVE is offered as an explicit transfer (`transferTarget`),
 * never picked. `exact` is the host's lookup of `binding.mapVersionId`
 * (`getMapVersionIdentity`), null when it does not exist here.
 */
export function resolveImportMap<T extends ImportMapCandidate>(
  binding: ScenarioMapBinding,
  installed: readonly T[],
  exact: ScenarioMapVersionIdentityDto | null,
): T | ImportMapCandidate {
  const requested = binding.mapVersionId;
  if (!requested) {
    throw new ScenarioImportMapError(
      "This file does not name the exact published map version it was authored on, so it cannot be bound to one. Export it again from a current Studio.",
      null,
      null,
    );
  }
  const declaredSha = binding.mapXodrSha256 ?? null;
  const verify = (xodrSha256: string | undefined | null, where: string) => {
    if (declaredSha && xodrSha256 && declaredSha !== xodrSha256) {
      throw new ScenarioImportMapError(
        `Map version ${requested} ${where} has OpenDRIVE ${xodrSha256.slice(0, 12)}, but the file was authored on ${declaredSha.slice(0, 12)}. The file does not match this installation's map version; it will not be imported onto different roads.`,
        requested,
        null,
      );
    }
  };
  const listed = installed.find((candidate) => candidate.mapVersionId === requested);
  if (listed) {
    verify(listed.artifacts?.xodrSha256, "installed here");
    return listed;
  }
  if (exact && exact.pinnable && exact.sourceMapId) {
    verify(exact.xodrSha256, "stored here");
    const label = installed.find((candidate) => candidate.sourceMapId === exact.sourceMapId)?.label ?? exact.sourceMapId;
    return { mapVersionId: exact.mapVersionId, sourceMapId: exact.sourceMapId, label, artifacts: { xodrSha256: exact.xodrSha256 } };
  }
  const sourceMapId = exact?.sourceMapId ?? binding.mapSourceMapId ?? null;
  const sameSource = sourceMapId ? installed.filter((candidate) => candidate.sourceMapId === sourceMapId) : [];
  const sameGeometry = declaredSha
    ? sameSource.filter((candidate) => candidate.artifacts?.xodrSha256 === declaredSha)
    : [];
  const target = sameGeometry.length === 1 ? sameGeometry[0]! : null;
  const why = exact
    ? `Map version ${requested} exists here but is ${exact.retiredAt ? "retired" : "no longer published"}, so a scenario can't be pinned to it.`
    : `Map version ${requested}${declaredSha ? ` (OpenDRIVE ${declaredSha.slice(0, 12)})` : ""}, which this file was authored on, does not exist in this installation.`;
  const offer = target
    ? ` Version ${target.mapVersionId} of the same map has identical road geometry: you can transfer the scenario onto it explicitly (it is re-simulated there).`
    : sameSource.length > 0
      ? " The installed version of that map has different road geometry; use Transfer to move the scenario onto it."
      : " Install that map (the exact version) to import it.";
  throw new ScenarioImportMapError(why + offer, requested, target);
}
