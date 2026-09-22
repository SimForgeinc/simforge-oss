import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeRenderTextureTier } from "../render-intent-store";

const rgb = (height: number) => ({ modality: "rgb", attributes: { width: Math.round(height * 16 / 9), height } });

test("native texture tier: current behaviour by default, resolution policy only when opted in", () => {
  assert.equal(nativeRenderTextureTier("ml", [rgb(1080)], {}), "bc7-512");
  assert.equal(nativeRenderTextureTier(undefined, [rgb(360)], {}), "uastc-full", "default policy keeps full textures");
  const policy = { SIMFORGE_NATIVE_TEXTURE_TIER_POLICY: "resolution" };
  assert.equal(nativeRenderTextureTier(undefined, [rgb(360), rgb(480)], policy), "bc7-512");
  assert.equal(nativeRenderTextureTier(undefined, [rgb(360), rgb(720)], policy), "uastc-full", "any >=720p camera keeps full textures");
  assert.equal(nativeRenderTextureTier(undefined, [{ modality: "lidar", attributes: {} }], policy), "uastc-full");
  assert.equal(nativeRenderTextureTier(undefined, [rgb(720)], { ...policy, SIMFORGE_NATIVE_FULL_TEXTURE_MIN_HEIGHT: "1080" }), "bc7-512");
});
