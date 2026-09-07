import { readArtifactJson } from "./archive";
import type { ExportArtifact } from "./sources";

/**
 * ODVG label generation and SDG manifest coverage checks, ported from the
 * SimCloud export runtime. Pure over `ExportArtifact` rows plus JSON documents
 * read from the local object store.
 */

type JsonRecord = Record<string, unknown>;

function parseMetadata(artifact: ExportArtifact): JsonRecord {
  if (!artifact.metadata_json) return {};
  try {
    const parsed = JSON.parse(artifact.metadata_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : {};
  } catch {
    return {};
  }
}

const IMAGE_MODALITIES: Record<string, true> = {
  rgb: true,
  depth: true,
  semantic_segmentation: true,
  instance_segmentation: true,
  normals: true,
};

export function isImageArtifact(artifact: ExportArtifact) {
  const modality = String(artifact.output_modality ?? "").toLowerCase();
  const type = String(artifact.content_type ?? "").toLowerCase();
  return IMAGE_MODALITIES[modality] === true || type.startsWith("image/");
}

export function isWorkerOdvgArtifact(artifact: ExportArtifact) {
  const modality = String(artifact.output_modality ?? "").toLowerCase();
  const artifactType = String(artifact.artifact_type ?? "").toLowerCase();
  const key = String(artifact.s3_key ?? "").toLowerCase();
  return (
    modality === "odvg" ||
    artifactType === "odvg" ||
    artifactType === "odvg_json" ||
    (key.includes("/odvg/") && key.endsWith(".json"))
  );
}

export function isSdgManifestArtifact(artifact: ExportArtifact) {
  const artifactType = String(artifact.artifact_type ?? "").toLowerCase();
  const modality = String(artifact.output_modality ?? "").toLowerCase();
  const key = String(artifact.s3_key ?? "").toLowerCase();
  return (
    artifactType === "sdg_manifest" ||
    (artifactType === "manifest" &&
      modality === "manifest" &&
      key.endsWith("/render_outputs/sdg_manifest.json")) ||
    key.endsWith("/sdg_manifest.json")
  );
}

export function isBundleIndexArtifact(artifact: ExportArtifact) {
  const artifactType = String(artifact.artifact_type ?? "").toLowerCase();
  const modality = String(artifact.output_modality ?? "").toLowerCase();
  const key = String(artifact.s3_key ?? "").toLowerCase();
  const filename = key.split("/").pop();
  return (
    filename === "bundle.index.json" ||
    artifactType === "bundle_index" ||
    artifactType === "sdg_bundle_index" ||
    (artifactType === "manifest" && modality === "bundle_index")
  );
}

export function isSdgArtifact(artifact: ExportArtifact) {
  const metadata = parseMetadata(artifact);
  const artifactType = String(artifact.artifact_type ?? "").toLowerCase();
  const modality = String(artifact.output_modality ?? "").toLowerCase();
  return (
    metadata.recipe_id === "sdg" ||
    metadata.sdgReference === "simforge.sdg.v1" ||
    artifactType === "sdg_manifest" ||
    artifactType === "sdg_bundle" ||
    modality === "odvg"
  );
}

/** Documents keyed by artifact id and by object key, as upstream. */
export async function readArtifactDocuments(artifacts: ExportArtifact[]) {
  const documents = new Map<string, JsonRecord>();
  for (const artifact of artifacts) {
    const document = await readArtifactJson<JsonRecord>(artifact);
    documents.set(artifact.id, document);
    if (artifact.s3_key) documents.set(artifact.s3_key, document);
  }
  return documents;
}

export type BundleIndexDocument = { artifactId: string; indexKey: string; document: JsonRecord };

export async function readBundleIndexDocuments(artifacts: ExportArtifact[]) {
  const documents: BundleIndexDocument[] = [];
  for (const artifact of artifacts) {
    documents.push({
      artifactId: artifact.id,
      indexKey: artifact.s3_key ?? "",
      document: await readArtifactJson<JsonRecord>(artifact),
    });
  }
  return documents;
}

function normalizeManifestPath(value: unknown) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^s3:\/\/[^/]+\/+/, "")
    .replace(/^\.?\//, "");
}

function availablePathMatchesManifestPath(availablePath: unknown, manifestPath: unknown) {
  const key = normalizeManifestPath(availablePath);
  const path = normalizeManifestPath(manifestPath);
  return Boolean(path && key && (key === path || key.endsWith(`/${path}`) || path.endsWith(`/${key}`)));
}

function collectSdgManifestRequiredPaths(manifest: JsonRecord) {
  const paths = new Set<string>();
  const items = Array.isArray(manifest.artifacts) ? (manifest.artifacts as JsonRecord[]) : [];
  for (const item of items) {
    const path = normalizeManifestPath(item?.path);
    if (path && path !== "render_outputs/calibration.json") paths.add(path);
  }
  const cosmosInputs = manifest.required_cosmos_inputs as JsonRecord | undefined;
  const video = normalizeManifestPath(cosmosInputs?.video);
  if (video) paths.add(video);
  const controls = cosmosInputs?.controls;
  if (controls && typeof controls === "object") {
    for (const value of Object.values(controls as JsonRecord)) {
      const path = normalizeManifestPath(value);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

function collectBundleIndexAvailablePaths(bundleIndexDocuments: BundleIndexDocument[]) {
  const paths = new Set<string>();
  for (const entry of bundleIndexDocuments) {
    const key = normalizeManifestPath(entry.indexKey);
    const prefix = key.toLowerCase().endsWith("bundle.index.json")
      ? key.slice(0, -"bundle.index.json".length).replace(/\/+$/, "")
      : "";
    const files = Array.isArray(entry.document.files) ? (entry.document.files as unknown[]) : [];
    for (const file of files) {
      const filePath = normalizeManifestPath(
        typeof file === "string" ? file : (file as JsonRecord | null)?.path,
      );
      if (!filePath) continue;
      paths.add(filePath);
      if (prefix) paths.add(`${prefix}/${filePath}`);
    }
  }
  return paths;
}

/**
 * Every path an SDG manifest declares must be present either as an exported
 * artifact or inside a bundle index; otherwise the package would be
 * unloadable and the export fails before writing anything.
 */
export function validateSdgManifestArtifactCoverage(
  artifacts: ExportArtifact[],
  manifestDocuments: JsonRecord[],
  bundleIndexDocuments: BundleIndexDocument[],
) {
  if (manifestDocuments.length === 0) return;
  const bundleIndexAvailablePaths = collectBundleIndexAvailablePaths(bundleIndexDocuments);
  const missing: string[] = [];
  for (const manifest of manifestDocuments) {
    for (const requiredPath of collectSdgManifestRequiredPaths(manifest)) {
      if (artifacts.some((artifact) => availablePathMatchesManifestPath(artifact.s3_key, requiredPath))) {
        continue;
      }
      let covered = false;
      for (const availablePath of bundleIndexAvailablePaths) {
        if (availablePathMatchesManifestPath(availablePath, requiredPath)) {
          covered = true;
          break;
        }
      }
      if (!covered) missing.push(requiredPath);
    }
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    const preview = unique.slice(0, 10).join(", ");
    const suffix = unique.length > 10 ? `, +${unique.length - 10} more` : "";
    throw new Error(`SDG manifest references missing artifact path(s): ${preview}${suffix}`);
  }
}

function firstPositiveNumber(...values: unknown[]) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function normalizeBox(raw: unknown): number[] | null {
  const record = raw as JsonRecord | null;
  const box = Array.isArray(raw)
    ? raw
    : record?.bbox_2d_visible_pixel ?? record?.bbox ?? record?.bbox_2d ?? record?.box ?? record?.xyxy;
  if (!Array.isArray(box) || box.length < 4) return null;
  const values = box.slice(0, 4).map(Number);
  return values.every(Number.isFinite) ? values : null;
}

type OdvgInstance = {
  bbox: number[];
  label: string;
  category: string;
  score?: number;
  instance_id: unknown;
  bbox_3d_world?: unknown;
  bbox_3d_camera?: unknown;
  bbox_quality?: unknown;
};

function toInstances(candidates: unknown, instanceIdOf: (item: JsonRecord, index: number) => unknown) {
  if (!Array.isArray(candidates)) return [] as OdvgInstance[];
  const instances: OdvgInstance[] = [];
  candidates.forEach((raw, index) => {
    const item = (raw ?? {}) as JsonRecord;
    const bbox = normalizeBox(item);
    if (!bbox) return;
    const score = Number(item.score);
    instances.push({
      bbox,
      label: String(item.label ?? item.category ?? item.class ?? "object"),
      category: String(item.category ?? item.label ?? item.class ?? "object"),
      ...(item.score == null || !Number.isFinite(score) ? {} : { score }),
      instance_id: instanceIdOf(item, index),
      ...(item.bbox_3d_world ? { bbox_3d_world: item.bbox_3d_world } : {}),
      ...(item.bbox_3d_camera ? { bbox_3d_camera: item.bbox_3d_camera } : {}),
      ...(item.bbox_quality ? { bbox_quality: item.bbox_quality } : {}),
    });
  });
  return instances;
}

const DEFAULT_CAPTION = "Traffic scene generated by SimForge using the SDG recipe.";

function buildWorkerOdvgJsonl(labelArtifacts: ExportArtifact[], documents: Map<string, JsonRecord>) {
  const records = labelArtifacts.map((artifact) => {
    const document = documents.get(artifact.id) ?? (artifact.s3_key ? documents.get(artifact.s3_key) : undefined);
    if (!document) {
      throw new Error(`Missing worker-produced SDG ODVG document for artifact ${artifact.id}`);
    }
    const detections = (document.detections ?? document.detection) as JsonRecord | undefined;
    const instances = toInstances(
      detections?.instances ?? document.instances ?? [],
      (item, index) => item["object-id"] ?? item.object_id ?? item.id ?? item.instance_id ?? index,
    );
    const fileName =
      document.image_filename ?? document.file_name ?? `${String(document.frame_id ?? artifact.id)}.jpg`;
    return {
      file_name: `images/${fileName}`,
      width: Number(document.width ?? 0),
      height: Number(document.height ?? 0),
      detection: { instances },
      grounding: {
        caption: document.caption ?? DEFAULT_CAPTION,
        regions: instances.map((instance) => ({ bbox: instance.bbox, phrase: instance.label })),
      },
      metadata: {
        artifact_id: artifact.id,
        scenario_id: artifact.scenario_id,
        simulation_id: artifact.simulation_id,
        frame_id: document.frame_id,
        source_s3_key: artifact.s3_key,
        source_label_artifact_id: artifact.id,
        sdg_reference: "simforge.sdg.worker-labels.v1",
      },
    };
  });
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

export function buildOdvgJsonl(
  artifacts: ExportArtifact[],
  workerLabelDocuments?: Map<string, JsonRecord>,
) {
  const workerLabelArtifacts = artifacts.filter(isWorkerOdvgArtifact);
  if (workerLabelArtifacts.length > 0 && workerLabelDocuments) {
    return buildWorkerOdvgJsonl(workerLabelArtifacts, workerLabelDocuments);
  }
  const records = artifacts.filter(isImageArtifact).map((artifact) => {
    const metadata = parseMetadata(artifact);
    const resolution = metadata.resolution as JsonRecord | undefined;
    const dimensions = metadata.dimensions as JsonRecord | undefined;
    const instances = toInstances(
      metadata.instances ?? metadata.detections ?? metadata.objects ?? metadata.annotations ?? [],
      (item, index) => item.id ?? item.instance_id ?? index,
    );
    const fileName = artifact.s3_key ? artifact.s3_key.split("/").pop() : `${artifact.id}.png`;
    return {
      file_name: `images/${fileName}`,
      width: firstPositiveNumber(
        metadata.width,
        metadata.image_width,
        metadata.imageWidth,
        resolution?.width,
        dimensions?.width,
      ),
      height: firstPositiveNumber(
        metadata.height,
        metadata.image_height,
        metadata.imageHeight,
        resolution?.height,
        dimensions?.height,
      ),
      detection: { instances },
      grounding: {
        caption: metadata.caption ?? DEFAULT_CAPTION,
        regions: instances.map((instance) => ({ bbox: instance.bbox, phrase: instance.label })),
      },
      metadata: {
        artifact_id: artifact.id,
        scenario_id: artifact.scenario_id,
        simulation_id: artifact.simulation_id,
        sensor_id: artifact.sensor_id,
        sensor_label: artifact.sensor_label,
        output_modality: artifact.output_modality,
        frame_index: artifact.frame_index == null ? 0 : Number(artifact.frame_index),
        source_s3_key: artifact.s3_key,
        sdg_reference: "simforge.sdg.v1",
      },
    };
  });
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}
