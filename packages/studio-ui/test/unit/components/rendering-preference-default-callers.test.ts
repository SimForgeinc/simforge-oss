import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every surface that needs a rendering profile before (or without) a saved
 * choice must use `DEFAULT_RENDERING_PREFERENCE`. A literal `?? "low"` or
 * `?? "medium"` next to the preference is how the viewers used to disagree
 * about the default.
 */
const REPO = resolve(__dirname, "../../../../..");
const ROOTS = ["packages/studio-ui/src", "studio/app"].map((root) => join(REPO, root));
const CALLERS = [
  "studio/app/dashboard/drive/[documentId]/DriverInTheLoopDrive.tsx",
  "studio/app/dashboard/map-assets/drive/[mapVersionId]/FreeDrive.tsx",
  "studio/app/dashboard/map-assets/catalog/MapGalleryPageClient.tsx",
  "studio/app/dashboard/map-assets/map-detail-sections/DigitalTwinLayersPanel.tsx",
  "studio/app/dashboard/map-assets/[mapAssetId]/DigitalTwinViewerPanel.tsx",
  "studio/app/host/cloud/RenderSettings.tsx",
  "studio/app/host/local/RenderSettings.tsx",
  "studio/app/host/local/OnboardingMapsSurface.tsx",
  "packages/studio-ui/src/scenario/editor/regions/slots/ViewportSettingsPanel.tsx",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("shared rendering-preference default", () => {
  it("has no literal profile fallback in any file that reads the preference", () => {
    const offenders = ROOTS.flatMap(sourceFiles)
      .filter((path) => /rendering-preference/.test(readFileSync(path, "utf8")))
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .map((line, index) => ({ line, at: `${relative(REPO, path)}:${index + 1}` }))
          .filter(({ line }) => /\?\?\s*["'](low|medium|low-no-foliage)["']/.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it.each(CALLERS)("%s falls back to DEFAULT_RENDERING_PREFERENCE", (caller) => {
    const source = readFileSync(join(REPO, caller), "utf8");
    expect(source).toMatch(/import \{[^}]*\bDEFAULT_RENDERING_PREFERENCE\b[^}]*\} from "[^"]*rendering-preference"/);
    expect(source).toMatch(/\?\? DEFAULT_RENDERING_PREFERENCE|useState<RenderingPreference>\(DEFAULT_RENDERING_PREFERENCE\)/);
  });

  it("no longer carries a hardware-probed automatic default", () => {
    const source = readFileSync(join(REPO, "packages/studio-ui/src/components/rendering-preference.ts"), "utf8");
    expect(source).not.toMatch(/automaticRenderingPreference|probeTextureCapabilities/);
  });
});
