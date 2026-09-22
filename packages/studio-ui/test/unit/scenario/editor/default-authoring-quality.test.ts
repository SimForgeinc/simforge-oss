// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAuthoringQuality } from "../../../../src/scenario/editor/authoring-quality";
import { saveRenderingPreference } from "../../../../src/components/rendering-preference";

describe("default authoring quality", () => {
  beforeEach(() => window.localStorage.clear());

  it.each(["low", "medium"] as const)(
    "starts new editor sessions with the saved %s quality",
    (quality) => {
      saveRenderingPreference(quality);
      expect(defaultAuthoringQuality()).toBe(quality);
    },
  );

  it("keeps no-foliage out of the editor texture-tier contract", () => {
    saveRenderingPreference("low-no-foliage");
    expect(defaultAuthoringQuality()).toBe("low");
  });
});
