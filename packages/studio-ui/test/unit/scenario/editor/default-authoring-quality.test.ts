// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAuthoringQuality } from "../../../../src/scenario/editor/authoring-quality";
import { saveRenderingPreference } from "../../../../src/components/rendering-preference";

describe("default authoring quality", () => {
  beforeEach(() => window.localStorage.clear());

  it.each(["roads-only", "ultra-low-3d", "minimal", "high"] as const)(
    "starts new editor sessions with the saved %s quality",
    (quality) => {
      saveRenderingPreference(quality);
      expect(defaultAuthoringQuality()).toBe(quality);
    },
  );

  it("defaults to high before a browser preference is saved", () => {
    expect(defaultAuthoringQuality()).toBe("high");
  });
});
