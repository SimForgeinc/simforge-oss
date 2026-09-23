/**
 * What "download this map at this render setting" means, in files.
 *
 * A map's published browser closure carries every texture tier at once plus
 * the full-resolution source textures the tiers were made from: Richmond Field
 * Station's closure is 1.5 GB, of which the browser at "Low · no foliage"
 * loads 59 MB. Downloading the closure would fill a 32 GB cache with bytes no
 * page ever reads, so a download plan is the closure narrowed to what the
 * viewer requests for one render profile:
 *
 * - every non-texture member (manifests, tiles, roads, semantics, SUMO, env),
 *   which the server lists without the texture rows
 *   (`/api/simforge/maps/download-plan`);
 * - the one texture tier the viewer selects for the profile, and only its
 *   images that a kept model references, read from that tier's own index
 *   (which carries each encoded image's digest and size);
 * - vegetation tiles and the images only they use, unless the profile keeps
 *   foliage.
 *
 * The rules mirror `CityViewer.configureTextureTier` and its vegetation
 * switch. A reference the closure does not contain is an error, never a
 * silently smaller plan.
 */

import type {
  CityAssetVariantManifest,
  TextureCapabilities,
  TextureTierIndex,
  TextureVariantId,
} from "@simforge-oss/viewer/asset-variants";
import { selectTextureTier } from "@simforge-oss/viewer/asset-variants";
import type { RenderingPreference } from "../../../components/rendering-preference";

/** One closure member as the download inventory lists it (paths are relative to the map's browser-assets root). */
export type DownloadInventoryAsset = {
  relativePath: string;
  sha256: string;
  byteLength: number;
};

export type DownloadInventory = {
  mapVersionId: string;
  closureSha256: string;
  assets: readonly DownloadInventoryAsset[];
};

/** The subset of the tiled city manifest a plan reads. */
export type DownloadCityManifest = {
  scene?: { gridDimensions?: readonly number[] };
  tiles?: ReadonlyArray<{ gridX: number; gridZ: number; lods: ReadonlyArray<{ file: string; triangles?: number }>; shadowLightmaps?: ReadonlyArray<{ file: string }> }>;
  staticLayers?: ReadonlyArray<{ id: string; file: string }>;
  vegetationTiles?: ReadonlyArray<{ gridX: number; gridZ: number; lods: ReadonlyArray<{ file: string }>; instanceFile?: string }>;
};

export type DownloadAssetKind = "core" | "roads" | "tile" | "vegetation" | "texture";

export type PlannedDownloadAsset = {
  /** First-party canonical URL (`/api/simforge/maps/<id>/browser-assets/<path>`). */
  url: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  kind: DownloadAssetKind;
  /**
   * What this asset draws: a grid cell `"x,z"`, {@link ROADS_CELL} for the
   * road layer and its textures, or null for map-wide files.
   */
  cell: string | null;
};

export type PlannedDownloadCell = {
  id: string;
  gridX: number;
  gridZ: number;
  /** Bytes of the cell's models and the textures first claimed by them. */
  bytes: number;
  /** Triangle count of the cell's finest building/terrain LOD, for the skyline's height. */
  triangles: number;
  hasVegetation: boolean;
};

export type MapDownloadPlan = {
  mapVersionId: string;
  closureSha256: string;
  preference: RenderingPreference;
  variantId: TextureVariantId;
  /** Why the viewer will use a different variant than the profile names, if it will. */
  variantNote: string | null;
  foliage: boolean;
  /** Stable identity of "this closure at this profile"; the completion receipt's key. */
  profileKey: string;
  /** Ordered: map-wide files, the road layer, then cells spiralling out from the centre. */
  assets: PlannedDownloadAsset[];
  totalBytes: number;
  columns: number;
  rows: number;
  cells: PlannedDownloadCell[];
};

/** The pseudo-cell of the road layer: it lights before any block rises. */
export const ROADS_CELL = "roads";

export function mapBrowserAssetUrl(mapVersionId: string, relativePath: string): string {
  const encoded = relativePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `/api/simforge/maps/${encodeURIComponent(mapVersionId)}/browser-assets/${encoded}`;
}

/** Normalise `3d/` + a path that may climb out of it (`../images/x.ktx2`). */
export function resolveClosurePath(base: string, relative: string): string {
  const parts = [...base.split("/").filter(Boolean)];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** The texture variant the viewer selects for a render profile on this GPU. */
export function textureVariantForPreference(
  preference: RenderingPreference,
  capabilities: TextureCapabilities,
): { variantId: TextureVariantId; note: string | null } {
  const tier = preference === "medium" ? "medium" : "low";
  const selection = selectTextureTier(tier, capabilities);
  return { variantId: selection.variantId as TextureVariantId, note: selection.downgradeReason };
}

export function renderProfileKey(closureSha256: string, variantId: TextureVariantId, foliage: boolean): string {
  return `map-profile::${closureSha256}::${variantId}::${foliage ? "foliage" : "no-foliage"}`;
}

export class MapDownloadPlanError extends Error {
  constructor(readonly mapVersionId: string, message: string) {
    super(message);
    this.name = "MapDownloadPlanError";
  }
}

/** Order cells from the grid centre outwards, so a map fills in like a city growing. */
function spiralRank(gridX: number, gridZ: number, columns: number, rows: number): number {
  const dx = gridX - (columns - 1) / 2;
  const dz = gridZ - (rows - 1) / 2;
  return Math.hypot(dx, dz) * 1000 + Math.atan2(dz, dx);
}

/**
 * Build the plan from what the server listed and the three small documents
 * the viewer itself reads first (the city manifest, the variant manifest and
 * the chosen tier's index). Pure: every input is passed in.
 */
export function buildMapDownloadPlan(input: {
  inventory: DownloadInventory;
  manifest: DownloadCityManifest;
  variants: Pick<CityAssetVariantManifest, "variants">;
  tierIndex: Pick<TextureTierIndex, "id" | "images" | "assets">;
  preference: RenderingPreference;
  variantId: TextureVariantId;
  variantNote?: string | null;
}): MapDownloadPlan {
  const { inventory, manifest, variants, tierIndex, preference, variantId } = input;
  const mapVersionId = inventory.mapVersionId;
  const foliage = preference !== "low-no-foliage";
  const fail = (message: string): never => { throw new MapDownloadPlanError(mapVersionId, message); };
  if (tierIndex.id !== variantId) fail(`texture index is ${tierIndex.id}, expected ${variantId}`);
  const reference = variants.variants[variantId];
  if (!reference) fail(`the ${variantId} texture tier is not published for this map`);
  const tierIndexPath = `3d/variants/${reference!.file}`;

  const members = new Map(inventory.assets.map((asset) => [asset.relativePath, asset]));
  const member = (path: string): DownloadInventoryAsset => members.get(path)
    ?? fail(`its closure does not contain ${path}, which the viewer loads`);

  const columns = Math.max(1, manifest.scene?.gridDimensions?.[0] ?? 0,
    ...(manifest.tiles ?? []).map((tile) => tile.gridX + 1),
    ...(manifest.vegetationTiles ?? []).map((tile) => tile.gridX + 1));
  const rows = Math.max(1, manifest.scene?.gridDimensions?.[1] ?? 0,
    ...(manifest.tiles ?? []).map((tile) => tile.gridZ + 1),
    ...(manifest.vegetationTiles ?? []).map((tile) => tile.gridZ + 1));

  // Files the viewer reads for foliage, and only for foliage.
  const vegetationPaths = new Set<string>();
  for (const tile of manifest.vegetationTiles ?? []) {
    for (const lod of tile.lods) vegetationPaths.add(resolveClosurePath("3d", lod.file));
    if (tile.instanceFile) vegetationPaths.add(resolveClosurePath("3d", tile.instanceFile));
  }

  // Which cell (if any) each model file draws in.
  const cellOf = new Map<string, string>();
  const cells = new Map<string, PlannedDownloadCell>();
  const cell = (gridX: number, gridZ: number) => {
    const id = `${gridX},${gridZ}`;
    let entry = cells.get(id);
    if (!entry) {
      entry = { id, gridX, gridZ, bytes: 0, triangles: 0, hasVegetation: false };
      cells.set(id, entry);
    }
    return entry;
  };
  for (const tile of manifest.tiles ?? []) {
    const entry = cell(tile.gridX, tile.gridZ);
    entry.triangles = Math.max(entry.triangles, ...tile.lods.map((lod) => lod.triangles ?? 0));
    for (const lod of tile.lods) cellOf.set(resolveClosurePath("3d", lod.file), entry.id);
    for (const map of tile.shadowLightmaps ?? []) cellOf.set(resolveClosurePath("3d", map.file), entry.id);
  }
  if (foliage) {
    for (const tile of manifest.vegetationTiles ?? []) {
      const entry = cell(tile.gridX, tile.gridZ);
      entry.hasVegetation = true;
      for (const lod of tile.lods) cellOf.set(resolveClosurePath("3d", lod.file), entry.id);
      if (tile.instanceFile) cellOf.set(resolveClosurePath("3d", tile.instanceFile), entry.id);
    }
  }
  const roadPaths = new Set((manifest.staticLayers ?? []).map((layer) => resolveClosurePath("3d", layer.file)));

  // Every model the manifest names must be in the closure; a missing one is
  // a broken publication, not a smaller download.
  for (const path of [...cellOf.keys(), ...roadPaths]) member(path);
  member(tierIndexPath);

  const kept: PlannedDownloadAsset[] = [];
  for (const asset of inventory.assets) {
    const path = asset.relativePath;
    if (path.startsWith("3d/variants/textures-") && path !== tierIndexPath) continue;
    if (!foliage && vegetationPaths.has(path)) continue;
    const cellId = roadPaths.has(path) ? ROADS_CELL : cellOf.get(path) ?? null;
    const kind: DownloadAssetKind = roadPaths.has(path) ? "roads"
      : cellId === null ? "core"
        : vegetationPaths.has(path) ? "vegetation" : "tile";
    kept.push({ url: mapBrowserAssetUrl(mapVersionId, path), relativePath: path, sha256: asset.sha256, bytes: asset.byteLength, kind, cell: cellId });
  }
  const keptPaths = new Set(kept.map((asset) => asset.relativePath));

  // The chosen tier's images that a kept model uses, each claimed by the
  // first model (in download order) that needs it.
  const textureFor = new Map<string, PlannedDownloadAsset>();
  const claim = (modelPath: string, cellId: string | null, into: PlannedDownloadAsset[]) => {
    const relative = modelPath.startsWith("3d/") ? modelPath.slice(3) : modelPath;
    const entry = tierIndex.assets[relative];
    if (!entry) return;
    for (const source of entry.images) {
      const image = tierIndex.images[source] ?? fail(`the ${variantId} index omits ${source}, which ${relative} uses`);
      if (textureFor.has(image.outputSha256)) continue;
      const path = resolveClosurePath("3d", image.file);
      const planned: PlannedDownloadAsset = {
        url: mapBrowserAssetUrl(mapVersionId, path), relativePath: path, sha256: image.outputSha256,
        bytes: image.bytes, kind: "texture", cell: cellId,
      };
      textureFor.set(image.outputSha256, planned);
      into.push(planned);
    }
  };

  const ordered: PlannedDownloadAsset[] = [];
  const core = kept.filter((asset) => asset.kind === "core").sort((a, b) => a.bytes - b.bytes);
  ordered.push(...core);
  for (const road of kept.filter((asset) => asset.kind === "roads")) {
    ordered.push(road);
    claim(road.relativePath, ROADS_CELL, ordered);
  }
  const cellOrder = [...cells.values()].sort((a, b) => spiralRank(a.gridX, a.gridZ, columns, rows) - spiralRank(b.gridX, b.gridZ, columns, rows));
  const byCell = new Map<string, PlannedDownloadAsset[]>();
  for (const asset of kept) {
    if (asset.cell === null) continue;
    const list = byCell.get(asset.cell) ?? [];
    list.push(asset);
    byCell.set(asset.cell, list);
  }
  for (const entry of cellOrder) {
    for (const model of (byCell.get(entry.id) ?? []).filter((asset) => asset.kind !== "roads")) {
      ordered.push(model);
      claim(model.relativePath, entry.id, ordered);
    }
  }
  // Models no cell or road owns (colliders, other GLBs) still pull their textures.
  for (const asset of core) {
    if (keptPaths.has(asset.relativePath)) claim(asset.relativePath, null, ordered);
  }

  for (const asset of ordered) {
    const owner = asset.cell === null ? undefined : cells.get(asset.cell);
    if (owner) owner.bytes += asset.bytes;
  }
  return {
    mapVersionId,
    closureSha256: inventory.closureSha256,
    preference,
    variantId,
    variantNote: input.variantNote ?? null,
    foliage,
    profileKey: renderProfileKey(inventory.closureSha256, variantId, foliage),
    assets: ordered,
    totalBytes: ordered.reduce((total, asset) => total + asset.bytes, 0),
    columns,
    rows,
    cells: cellOrder,
  };
}
