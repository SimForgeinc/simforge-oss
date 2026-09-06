import { describe, expect, it } from "vitest";
import {
  collectGalleryCatalogIds,
  galleryCatalogEntry,
} from "../../../src/lib/asset-gallery/catalog-entry";
import {
  GALLERY_ACTOR_CLASSES,
  GALLERY_ARCHETYPE_ACTOR_CLASSES,
  GALLERY_MOTION_ARCHETYPES,
  GalleryActorClassSchema,
  galleryMotionArchetypeFor,
} from "../../../src/lib/asset-gallery/contracts";

/**
 * An upload's class decides what the editor can ever do with the model: a
 * `static_object` is placed as a prop that editor-core refuses to un-fix, a
 * ground or flying class is placed as a routable role, and a vehicle is anchored
 * to an OpenDRIVE lane like the built-in cars. The archetype question exists so
 * that decision is stated rather than inherited, which means the mapping between
 * the two vocabularies has to stay total and non-overlapping.
 */
describe("gallery motion archetypes", () => {
  it("maps every archetype to at least one real actor class", () => {
    for (const archetype of GALLERY_MOTION_ARCHETYPES) {
      const classes: readonly string[] = GALLERY_ARCHETYPE_ACTOR_CLASSES[archetype];
      expect(classes.length).toBeGreaterThan(0);
      for (const actorClass of classes) {
        expect(GalleryActorClassSchema.parse(actorClass)).toBe(actorClass);
      }
    }
  });

  it("claims every actor class exactly once", () => {
    const claimed = GALLERY_MOTION_ARCHETYPES.flatMap(
      (archetype) => [...GALLERY_ARCHETYPE_ACTOR_CLASSES[archetype]] as string[],
    );
    expect([...claimed].sort()).toEqual([...GALLERY_ACTOR_CLASSES].sort());
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("resolves a stored class back to the archetype that offers it", () => {
    expect(galleryMotionArchetypeFor("static_object")).toBe("static");
    expect(galleryMotionArchetypeFor("sidewalk_robot")).toBe("ground");
    expect(galleryMotionArchetypeFor("pedestrian")).toBe("ground");
    expect(galleryMotionArchetypeFor("animal")).toBe("ground");
    expect(galleryMotionArchetypeFor("drone")).toBe("flying");
    expect(galleryMotionArchetypeFor("vehicle")).toBe("road_vehicle");
  });

  it("keeps road vehicles separate from ground actors so lane anchoring stays decidable", () => {
    expect(GALLERY_ARCHETYPE_ACTOR_CLASSES.road_vehicle).toEqual(["vehicle"]);
    expect(GALLERY_ARCHETYPE_ACTOR_CLASSES.ground).not.toContain("vehicle");
  });
});

describe("gallery compiler catalog entries", () => {
  it("preserves persisted vehicle geometry and model binding while normalizing its actor class", () => {
    const entry = galleryCatalogEntry({
      catalogId: "gallery.90dc9cf7-5c32-4a97-b43b-768f2749a221.v1",
      label: "Kia Carnival",
      actorClass: "vehicle",
      dims: { l: 5.155, w: 1.995, h: 1.775 },
      tags: ["passenger", "not-a-prop-tag"],
      model: {
        url: "https://bucket.s3.us-east-1.amazonaws.com/gallery/kia-carnival.glb",
        contentHash: "a".repeat(64),
        animated: false,
      },
    });
    expect(entry).toMatchObject({
      id: "gallery.90dc9cf7-5c32-4a97-b43b-768f2749a221.v1",
      class: "vehicle",
      actorClass: "car",
      dims: { l: 5.155, w: 1.995, h: 1.775 },
      tags: ["passenger"],
      model: {
        kind: "glb",
        url: "https://bucket.s3.us-east-1.amazonaws.com/gallery/kia-carnival.glb",
        contentHash: "a".repeat(64),
        animated: false,
      },
    });
  });

  it("collects only unique persisted gallery catalog references", () => {
    const catalogId = "gallery.90dc9cf7-5c32-4a97-b43b-768f2749a221.v1";
    expect(collectGalleryCatalogIds({
      roles: [{ actor: { catalogId } }, { actor: { catalogId: "vehicle.sedan" } }],
      props: [{ catalogId }],
    })).toEqual([catalogId]);
  });
});
