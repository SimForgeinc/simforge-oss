import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ASSET_GALLERY_HOST_ACTIONS } from "../asset-gallery-actions";

/**
 * The model gallery's host slot. A local installation adds nothing to the
 * gallery besides "Import model"; a hosted deployment replaces the slot module
 * to add services it runs itself. These checks keep OSS Studio on the empty
 * side of that seam.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("a local installation adds no gallery actions", () => {
  assert.deepEqual(ASSET_GALLERY_HOST_ACTIONS, []);
});

test("the gallery offers host actions only through the slot", async () => {
  const page = await readFile(path.join(appRoot, "dashboard/assets/AssetGalleryPageClient.tsx"), "utf8");
  assert.match(page, /from "@\/app\/lib\/host\/asset-gallery-actions"/);
  // No built-in way to add a model besides importing one: every other action,
  // its button and its dialog, comes from the host.
  assert.doesNotMatch(page, /Generat/);
  assert.doesNotMatch(page, /Sparkles/);
});
