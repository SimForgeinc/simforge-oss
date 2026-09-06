import { describe, expect, it } from "vitest";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { SimScenarioInput } from "@simforge-oss/engine";
import {
  STUDIO_BODY_COLOR_TAG_PREFIX,
  normalizeStudioBodyColor,
  withStudioBodyColorTags,
} from "@simforge-oss/compiler";

/**
 * The exact validator `@simforge-oss/playback` applies before it accepts a
 * `studio:body-color:` tag as `PlaybackActor.bodyColor`. A tag that fails this
 * is reported as a bundle issue and the actor is dropped from playback, so the
 * emitted format is a hard contract, not a preference.
 */
const PLAYBACK_BODY_COLOR = /^#[0-9a-f]{6}$/i;

function template(roles: Array<{ id: string; bodyColor?: unknown }>): ScenarioTemplateV2 {
  return {
    roles: roles.map((role) => ({
      id: role.id,
      ...(role.bodyColor === undefined
        ? {}
        : { extensions: { "studio.presentation.bodyColor": role.bodyColor } }),
    })),
  } as unknown as ScenarioTemplateV2;
}

function input(actors: Array<{ id: string; tags: string[] }>): SimScenarioInput {
  return { actors } as unknown as SimScenarioInput;
}

describe("normalizeStudioBodyColor", () => {
  it("passes through the inspector palette as lowercase #rrggbb", () => {
    expect(normalizeStudioBodyColor("#2F4F74")).toBe("#2f4f74");
  });

  it("expands #rgb shorthand", () => {
    expect(normalizeStudioBodyColor("#0AF")).toBe("#00aaff");
  });

  it("converts the native r,g,b palette used by older drafts", () => {
    // vehicleColorValues in app/lib/scenario-editor/actor-utils.ts
    expect(normalizeStudioBodyColor("0,201,167")).toBe("#00c9a7");
    expect(normalizeStudioBodyColor("rgb(200, 30, 30)")).toBe("#c81e1e");
  });

  it("rejects values playback would refuse rather than emitting a bad tag", () => {
    for (const bad of ["", "  ", "red", "#12", "#1234567", "0,201", "0,201,300", "-1,0,0", "1.5,0,0", null, 42]) {
      expect(normalizeStudioBodyColor(bad)).toBeNull();
    }
  });
});

describe("withStudioBodyColorTags", () => {
  it("projects the authored role paint onto the materialized actor", () => {
    const result = withStudioBodyColorTags(
      input([{ id: "a", tags: ["role:hero", "class:vehicle", "catalog:vehicle.lincoln.mkz"] }]),
      template([{ id: "hero", bodyColor: "#8C2F2F" }]),
    );

    // The regression: without this tag playback derives no bodyColor at all and
    // the renderer falls back to its default tint.
    expect(result.actors[0]!.tags).toContain(`${STUDIO_BODY_COLOR_TAG_PREFIX}#8c2f2f`);
    const emitted = result.actors[0]!.tags
      .filter((tag) => tag.startsWith(STUDIO_BODY_COLOR_TAG_PREFIX))
      .map((tag) => tag.slice(STUDIO_BODY_COLOR_TAG_PREFIX.length));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatch(PLAYBACK_BODY_COLOR);
  });

  it("preserves the tags the materializer authored", () => {
    const result = withStudioBodyColorTags(
      input([{ id: "a", tags: ["role:hero", "class:vehicle", "motion:reverse"] }]),
      template([{ id: "hero", bodyColor: "#2f6b3f" }]),
    );

    expect(result.actors[0]!.tags).toEqual([
      "role:hero",
      "class:vehicle",
      "motion:reverse",
      `${STUDIO_BODY_COLOR_TAG_PREFIX}#2f6b3f`,
    ]);
  });

  it("replaces a stale tag on a replayed base input instead of duplicating it", () => {
    // Playback rejects an actor carrying two studio:body-color tags outright.
    const result = withStudioBodyColorTags(
      input([{ id: "a", tags: ["role:hero", `${STUDIO_BODY_COLOR_TAG_PREFIX}#0d0f12`] }]),
      template([{ id: "hero", bodyColor: "#e8e9ea" }]),
    );

    expect(result.actors[0]!.tags).toEqual(["role:hero", `${STUDIO_BODY_COLOR_TAG_PREFIX}#e8e9ea`]);
  });

  it("drops the tag when the document no longer authors a paint", () => {
    const result = withStudioBodyColorTags(
      input([{ id: "a", tags: ["role:hero", `${STUDIO_BODY_COLOR_TAG_PREFIX}#0d0f12`] }]),
      template([{ id: "hero" }]),
    );

    expect(result.actors[0]!.tags).toEqual(["role:hero"]);
  });

  it("is idempotent, so recompiling does not change the input", () => {
    const doc = template([{ id: "hero", bodyColor: "#c98a2e" }]);
    const once = withStudioBodyColorTags(input([{ id: "a", tags: ["role:hero"] }]), doc);
    expect(withStudioBodyColorTags(once, doc)).toBe(once);
  });

  it("leaves untinted and ambient actors untouched by identity", () => {
    // Ambient actors carry no role: tag, so nothing can be attributed to them,
    // and an unchanged input must keep its hash stable.
    const original = input([
      { id: "ambient-1", tags: ["ambient", "class:vehicle"] },
      { id: "b", tags: ["role:extra", "class:vehicle"] },
    ]);

    expect(withStudioBodyColorTags(original, template([{ id: "hero", bodyColor: "#2f4f74" }]))).toBe(
      original,
    );
  });
});
