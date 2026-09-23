// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAuthoringQuality } from "../../../../src/scenario/editor/authoring-quality";
import { DEFAULT_RENDERING_PREFERENCE, renderingPreferenceQuality, saveRenderingPreference } from "../../../../src/components/rendering-preference";
import { DEFAULT_SCENARIO_AUTHORING_QUALITY_ID } from "../../../../src/lib/scenario/contracts";

describe("default authoring quality", () => {
  beforeEach(() => window.localStorage.clear());

  it.each(["low", "medium"] as const)(
    "starts new editor sessions with the saved %s quality",
    (quality) => {
      saveRenderingPreference(quality);
      expect(defaultAuthoringQuality()).toBe(quality);
    },
  );

  it("starts at the default profile's Low tier when nothing is saved", () => {
    expect(defaultAuthoringQuality()).toBe("low");
  });

  it("gives new documents the default profile's texture tier", () => {
    expect(DEFAULT_SCENARIO_AUTHORING_QUALITY_ID).toBe(renderingPreferenceQuality(DEFAULT_RENDERING_PREFERENCE));
  });

  it("keeps no-foliage out of the editor texture-tier contract", () => {
    saveRenderingPreference("low-no-foliage");
    expect(defaultAuthoringQuality()).toBe("low");
  });
});
