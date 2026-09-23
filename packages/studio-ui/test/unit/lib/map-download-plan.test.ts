import { describe, expect, it } from "vitest";
import {
  buildMapDownloadPlan,
  MapDownloadPlanError,
  ROADS_CELL,
  renderProfileKey,
  resolveClosurePath,
  textureVariantForPreference,
  type DownloadInventory,
} from "../../../src/lib/maps/frontend/map-download-plan";
import type { RenderingPreference } from "../../../src/components/rendering-preference";

const sha = (n: number) => n.toString(16).padStart(64, "0");

/**
 * A two-tile map with a road layer, one vegetation tile and two published
 * texture tiers. The closure also names the other tiers' index files, which a
 * plan must leave out.
 */
const inventory: DownloadInventory = {
  mapVersionId: "map-1",
  closureSha256: "c".repeat(64),
  assets: [
    { relativePath: "3d/manifest.json", sha256: sha(1), byteLength: 100 },
    { relativePath: "3d/variants/manifest.json", sha256: sha(2), byteLength: 50 },
    { relativePath: "3d/variants/textures-256-uastc-a.json", sha256: sha(3), byteLength: 30 },
    { relativePath: "3d/variants/textures-512-bc7-b.json", sha256: sha(4), byteLength: 40 },
    { relativePath: "3d/tiles/road.glb", sha256: sha(5), byteLength: 1_000 },
    { relativePath: "3d/tiles/tile_0_0.lod0.glb", sha256: sha(6), byteLength: 2_000 },
    { relativePath: "3d/tiles/tile_1_0.lod0.glb", sha256: sha(7), byteLength: 3_000 },
    { relativePath: "3d/tiles/veg_1_0.lod0.glb", sha256: sha(8), byteLength: 5_000 },
    { relativePath: "map.xodr", sha256: sha(9), byteLength: 700 },
  ],
};

const manifest = {
  scene: { gridDimensions: [2, 1] },
  staticLayers: [{ id: "road", file: "tiles/road.glb" }],
  tiles: [
    { gridX: 0, gridZ: 0, lods: [{ file: "tiles/tile_0_0.lod0.glb", triangles: 10 }] },
    { gridX: 1, gridZ: 0, lods: [{ file: "tiles/tile_1_0.lod0.glb", triangles: 1_000 }] },
  ],
  vegetationTiles: [{ gridX: 1, gridZ: 0, lods: [{ file: "tiles/veg_1_0.lod0.glb" }] }],
};

const variants = {
  variants: {
    "textures-256-uastc": { id: "textures-256-uastc", schemaVersion: 1, file: "textures-256-uastc-a.json", outputSha256: sha(3), digest: "", sourceManifestSha256: "", bytes: 30 },
    "textures-512-bc7": { id: "textures-512-bc7", schemaVersion: 1, file: "textures-512-bc7-b.json", outputSha256: sha(4), digest: "", sourceManifestSha256: "", bytes: 40 },
  },
} as const;

function tier(id: "textures-256-uastc" | "textures-512-bc7", scale: number) {
  const image = (n: number, bytes: number) => ({
    file: `variants/objects/${sha(100 + n + scale)}.ktx2`, outputSha256: sha(100 + n + scale), bytes: bytes * scale,
    sourceSha256: "", width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, levels: 1, residentBytes: 1, codec: "uastc" as const,
  });
  return {
    id,
    images: {
      "../images/road.ktx2": image(1, 10),
      "../images/wall.ktx2": image(2, 20),
      "../images/leaf.ktx2": image(3, 40),
      "../images/unused.ktx2": image(4, 999),
    },
    assets: {
      "tiles/road.glb": { images: ["../images/road.ktx2"] },
      "tiles/tile_0_0.lod0.glb": { images: ["../images/wall.ktx2"] },
      "tiles/tile_1_0.lod0.glb": { images: ["../images/wall.ktx2"] },
      "tiles/veg_1_0.lod0.glb": { images: ["../images/leaf.ktx2", "../images/wall.ktx2"] },
    },
  };
}

function plan(preference: RenderingPreference) {
  const variantId = preference === "medium" ? "textures-512-bc7" as const : "textures-256-uastc" as const;
  return buildMapDownloadPlan({
    inventory,
    manifest,
    variants: variants as never,
    tierIndex: tier(variantId, preference === "medium" ? 4 : 1) as never,
    preference,
    variantId,
  });
}

const CORE = 100 + 50 + 700;

describe("render-profile download plans", () => {
  it("Low · no foliage: models without vegetation, the 256 px tier, and only images a kept model uses", () => {
    const result = plan("low-no-foliage");
    const paths = result.assets.map((asset) => asset.relativePath);
    expect(paths).not.toContain("3d/tiles/veg_1_0.lod0.glb");
    expect(paths).not.toContain("3d/variants/textures-512-bc7-b.json");
    expect(paths).toContain("3d/variants/textures-256-uastc-a.json");
    // road + wall images; the leaf is vegetation-only and the unused image is never loaded.
    expect(result.assets.filter((asset) => asset.kind === "texture").map((asset) => asset.bytes)).toEqual([10, 20]);
    expect(result.totalBytes).toBe(CORE + 30 + 1_000 + 2_000 + 3_000 + 10 + 20);
    expect(result.foliage).toBe(false);
  });

  it("recomputes the size when the setting changes", () => {
    const noFoliage = plan("low-no-foliage").totalBytes;
    const low = plan("low").totalBytes;
    const medium = plan("medium").totalBytes;
    // Low adds the vegetation tile and the leaf texture.
    expect(low - noFoliage).toBe(5_000 + 40);
    // Medium swaps the 256 px index and images for the 512 px ones.
    expect(medium).toBe(CORE + 40 + 1_000 + 2_000 + 3_000 + 5_000 + (10 + 20 + 40) * 4);
    expect(new Set([noFoliage, low, medium]).size).toBe(3);
  });

  it("orders map-wide files, then roads, then lots from the centre out, each with its textures", () => {
    const result = plan("low");
    const kinds = result.assets.map((asset) => asset.kind);
    expect(kinds.indexOf("roads")).toBeGreaterThan(kinds.lastIndexOf("core"));
    expect(result.assets.find((asset) => asset.kind === "roads")!.cell).toBe(ROADS_CELL);
    // The road texture belongs to the roads, the wall texture to the first lot that needs it.
    expect(result.assets.find((asset) => asset.bytes === 10)!.cell).toBe(ROADS_CELL);
    const wall = result.assets.find((asset) => asset.bytes === 20)!;
    expect(wall.cell).toBe(result.assets.find((asset) => asset.kind === "tile")!.cell);
    expect(result.cells.map((cell) => cell.id).sort()).toEqual(["0,0", "1,0"]);
    expect(result.cells.find((cell) => cell.id === "1,0")!.hasVegetation).toBe(true);
    expect(result.columns).toBe(2);
    expect(result.rows).toBe(1);
  });

  it("names every file by its first-party URL and keys completion by closure and profile", () => {
    const result = plan("low-no-foliage");
    expect(result.assets[0]!.url).toMatch(/^\/api\/simforge\/maps\/map-1\/browser-assets\//);
    expect(result.profileKey).toBe(renderProfileKey(inventory.closureSha256, "textures-256-uastc", false));
    expect(plan("low").profileKey).not.toBe(result.profileKey);
  });

  it("fails loudly when the closure lacks a model the manifest names", () => {
    const broken = { ...inventory, assets: inventory.assets.filter((asset) => !asset.relativePath.endsWith("tile_1_0.lod0.glb")) };
    expect(() => buildMapDownloadPlan({
      inventory: broken, manifest, variants: variants as never, tierIndex: tier("textures-256-uastc", 1) as never,
      preference: "low", variantId: "textures-256-uastc",
    })).toThrow(MapDownloadPlanError);
  });

  it("fails loudly when the requested tier is not published", () => {
    expect(() => buildMapDownloadPlan({
      inventory, manifest, variants: { variants: {} } as never, tierIndex: tier("textures-256-uastc", 1) as never,
      preference: "low", variantId: "textures-256-uastc",
    })).toThrow(/not published/);
  });

  it("resolves index paths that climb out of 3d/", () => {
    expect(resolveClosurePath("3d", "../images/x.ktx2")).toBe("images/x.ktx2");
    expect(resolveClosurePath("3d", "variants/objects/a.ktx2")).toBe("3d/variants/objects/a.ktx2");
  });

  it("chooses the texture variant the viewer chooses", () => {
    const gpu = { bc7: true, astc: false, maxTextureSize: 4096 };
    expect(textureVariantForPreference("low-no-foliage", gpu).variantId).toBe("textures-256-uastc");
    expect(textureVariantForPreference("low", gpu).variantId).toBe("textures-256-uastc");
    expect(textureVariantForPreference("medium", gpu).variantId).toBe("textures-512-bc7");
    expect(textureVariantForPreference("medium", { bc7: false, astc: true, maxTextureSize: 4096 }).variantId).toBe("textures-512-astc");
    expect(textureVariantForPreference("medium", { bc7: false, astc: false, maxTextureSize: 256 }).variantId).toBe("textures-256-uastc");
  });
});
