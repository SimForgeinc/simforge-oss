"use client";

import { probeTextureCapabilities, type TextureCapabilities, type TextureTierIndex, type TextureVariantId, type CityAssetVariantManifest } from "@simforge-oss/viewer/asset-variants";
import type { RenderingPreference } from "../../../components/rendering-preference";
import { fetchMapAsset, hasCachedMapAsset, mapAssetDigestResident } from "./map-asset-cache";
import {
  buildMapDownloadPlan,
  mapBrowserAssetUrl,
  MapDownloadPlanError,
  textureVariantForPreference,
  type DownloadCityManifest,
  type DownloadInventory,
  type MapDownloadPlan,
} from "./map-download-plan";

/**
 * Turns "these maps at this render setting" into download plans: one small
 * server request for the maps' non-texture members, then the three documents
 * the viewer reads first for each map (fetched through the map cache, so they
 * are part of the download rather than extra traffic), then the pure
 * {@link buildMapDownloadPlan}.
 *
 * Plans are memoised per closure and profile for the life of the page: a
 * published closure is immutable, so reopening the panel or switching the
 * render setting back costs nothing.
 */

export type MapDownloadPlanOutcome =
  | { mapVersionId: string; ok: true; plan: MapDownloadPlan }
  | { mapVersionId: string; ok: false; reason: string };

type InventoryResponse = {
  maps: DownloadInventory[];
  unavailable: Array<{ mapVersionId: string; reason: string }>;
};

const PLAN_CONCURRENCY = 4;
const planMemo = new Map<string, Promise<MapDownloadPlan>>();
const inventoryMemo = new Map<string, DownloadInventory>();
let capabilities: TextureCapabilities | null = null;

/** Probe the WebGL context the viewer will upload textures to, once per page. */
function textureCapabilities(): TextureCapabilities {
  if (capabilities) return capabilities;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL is unavailable, so no texture tier can be chosen for Medium.");
    capabilities = probeTextureCapabilities(gl);
    return capabilities;
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Test seam. */
export function resetMapDownloadPlansForTests(): void {
  planMemo.clear();
  inventoryMemo.clear();
  capabilities = null;
}

async function fetchInventories(ids: readonly string[], signal?: AbortSignal): Promise<InventoryResponse> {
  const missing = ids.filter((id) => !inventoryMemo.has(id));
  const unavailable: InventoryResponse["unavailable"] = [];
  if (missing.length > 0) {
    const query = new URLSearchParams();
    for (const id of missing) query.append("mapVersionId", id);
    const response = await fetch(`/api/simforge/maps/download-plan?${query}`, { cache: "no-store", signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`The map download inventory could not be loaded (${response.status}).`);
    const body = await response.json() as InventoryResponse;
    for (const map of body.maps) inventoryMemo.set(map.mapVersionId, map);
    unavailable.push(...body.unavailable);
  }
  return { maps: ids.flatMap((id) => inventoryMemo.get(id) ?? []), unavailable };
}

async function fetchJson<T>(mapVersionId: string, inventory: DownloadInventory, path: string, signal?: AbortSignal): Promise<T> {
  const member = inventory.assets.find((asset) => asset.relativePath === path);
  if (!member) throw new MapDownloadPlanError(mapVersionId, `its closure does not contain ${path}`);
  const response = await fetchMapAsset(mapBrowserAssetUrl(mapVersionId, path), { credentials: "same-origin", signal }, member.sha256);
  if (!response.ok) throw new MapDownloadPlanError(mapVersionId, `${path} could not be read (${response.status})`);
  return await response.json() as T;
}

async function planOne(inventory: DownloadInventory, preference: RenderingPreference, signal?: AbortSignal): Promise<MapDownloadPlan> {
  const id = inventory.mapVersionId;
  const [manifest, variants] = await Promise.all([
    fetchJson<DownloadCityManifest>(id, inventory, "3d/manifest.json", signal),
    fetchJson<CityAssetVariantManifest>(id, inventory, "3d/variants/manifest.json", signal),
  ]);
  // Low never depends on the GPU's formats (always 256 px UASTC); Medium
  // follows the same selection and published-variant fallback as the viewer.
  const selected = preference === "medium"
    ? textureVariantForPreference(preference, textureCapabilities())
    : { variantId: "textures-256-uastc" as TextureVariantId, note: null };
  let { variantId } = selected;
  let note = selected.note;
  if (!variants.variants[variantId] && preference === "medium" && variantId !== "textures-512-uastc") {
    note = `Published ${variantId} textures are unavailable; the viewer uses portable UASTC`;
    variantId = "textures-512-uastc";
  }
  const reference = variants.variants[variantId];
  if (!reference || !("file" in reference)) throw new MapDownloadPlanError(id, `the ${variantId} texture tier is not published for this map`);
  const tierIndex = await fetchJson<TextureTierIndex>(id, inventory, `3d/variants/${reference.file}`, signal);
  return buildMapDownloadPlan({ inventory, manifest, variants, tierIndex, preference, variantId, variantNote: note });
}

/**
 * Plan every requested map. Each map gets an outcome: a plan, or the reason
 * it cannot be downloaded (not registered, no verified browser assets, a
 * closure that does not contain what its manifest names). Nothing is dropped.
 */
export async function loadMapDownloadPlans(
  mapVersionIds: readonly string[],
  preference: RenderingPreference,
  options: { signal?: AbortSignal; onPlan?: (outcome: MapDownloadPlanOutcome) => void } = {},
): Promise<MapDownloadPlanOutcome[]> {
  const { signal, onPlan } = options;
  const outcomes = new Map<string, MapDownloadPlanOutcome>();
  const settle = (outcome: MapDownloadPlanOutcome) => {
    outcomes.set(outcome.mapVersionId, outcome);
    onPlan?.(outcome);
  };
  const { maps, unavailable } = await fetchInventories(mapVersionIds, signal);
  for (const entry of unavailable) settle({ mapVersionId: entry.mapVersionId, ok: false, reason: entry.reason });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(PLAN_CONCURRENCY, maps.length) }, async () => {
    while (cursor < maps.length) {
      const inventory = maps[cursor++]!;
      const key = `${inventory.closureSha256}::${preference}`;
      let pending = planMemo.get(key);
      if (!pending) {
        pending = planOne(inventory, preference, signal);
        planMemo.set(key, pending);
        // A cancelled or failed plan is not remembered.
        pending.catch(() => planMemo.delete(key));
      }
      try {
        settle({ mapVersionId: inventory.mapVersionId, ok: true, plan: await pending });
      } catch (error) {
        if (signal?.aborted) throw error;
        settle({ mapVersionId: inventory.mapVersionId, ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }));
  return mapVersionIds.map((id) => outcomes.get(id)
    ?? { mapVersionId: id, ok: false, reason: "The server did not report this map." });
}

/**
 * Bytes of a plan already held by the cache, and the cells (plus the road
 * layer) whose files are all resident. The browser cache answers from its
 * byte index; the desktop cache is asked per asset.
 */
export async function planResidency(plan: MapDownloadPlan): Promise<{ residentBytes: number; lit: Set<string> }> {
  let residentBytes = 0;
  const incomplete = new Set<string>();
  const drawn = new Set<string>(plan.cells.map((cell) => cell.id));
  for (const asset of plan.assets) {
    if (asset.cell) drawn.add(asset.cell);
    const quick = mapAssetDigestResident(asset.sha256, asset.url);
    const resident = quick ?? await hasCachedMapAsset(asset.url, asset.sha256);
    if (resident) residentBytes += asset.bytes;
    else if (asset.cell) incomplete.add(asset.cell);
  }
  return { residentBytes, lit: new Set([...drawn].filter((cell) => !incomplete.has(cell))) };
}
