import { readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { MAP_CORPUS_PROFILES, type E2eContext } from "./context";
import { E2E_ENV, envValue } from "./env";
import { PREREQUISITES, requirePrerequisites } from "./prerequisites";

/**
 * Expose real installed maps to a test without copying gigabytes and without
 * letting the test write into the developer's corpus: each map's profile
 * directories are symlinked into the isolated cache root, so reads hit the
 * real bundles while everything Studio creates stays in the sandbox.
 *
 * Fails with the prerequisite record when no corpus is configured, and with an
 * explicit error when a requested map is not fully installed.
 */
export async function linkInstalledMaps(context: E2eContext, mapIds: readonly string[]): Promise<string[]> {
  await requirePrerequisites(context, [PREREQUISITES.realMaps]);
  const corpus = envValue(E2E_ENV.mapsFixtureRoot);
  if (corpus === undefined) throw new Error(`${E2E_ENV.mapsFixtureRoot} disappeared after the prerequisite check`);

  const installed: Record<string, string[]> = {};
  for (const profile of MAP_CORPUS_PROFILES) {
    try {
      installed[profile] = await readdir(join(corpus, profile));
    } catch {
      installed[profile] = [];
    }
  }
  const missing = mapIds.filter((mapId) => !(installed["dev-assets"] ?? []).includes(mapId));
  if (missing.length > 0) {
    throw new Error(
      `Maps ${missing.join(", ")} are not installed under ${corpus}/dev-assets; `
      + "pull them with `simforge maps pull <map>@<version>` into that corpus",
    );
  }
  const linked: string[] = [];
  for (const mapId of mapIds) {
    for (const profile of MAP_CORPUS_PROFILES) {
      if (!(installed[profile] ?? []).includes(mapId)) continue;
      await symlink(join(corpus, profile, mapId), join(context.mapsCacheRoot, profile, mapId), "dir");
    }
    linked.push(mapId);
  }
  return linked;
}

/** Map ids installed in the configured real corpus, or an empty list when none is configured. */
export async function installedMapIds(): Promise<string[]> {
  const corpus = envValue(E2E_ENV.mapsFixtureRoot);
  if (corpus === undefined) return [];
  try {
    return (await readdir(join(corpus, "dev-assets"))).sort();
  } catch {
    return [];
  }
}
