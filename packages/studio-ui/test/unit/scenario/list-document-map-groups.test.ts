import { describe, expect, it } from "vitest";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import {
  groupDocumentsByMap,
  groupVariationsBySource,
} from "../../../src/scenario/list/document-map-groups";

function summary(
  overrides: Partial<ScenarioDocumentSummaryDto> = {},
): ScenarioDocumentSummaryDto {
  return {
    id: "uscn_1",
    workspaceId: "ws_1",
    title: "Scenario",
    description: null,
    datasetId: "usds_1",
    datasetSortOrder: 0,
    mapVersionId: "usmv_a",
    mapLabel: "Map A",
    latestRevisionId: null,
    revisionCount: 0,
    archetype: null,
    author: null,
    contentTags: [],
    tags: [],
    roleCount: 0,
    hasSensorProfile: false,
    propCount: 0,
    variantCount: 0,
    clipSeconds: null,
    negativeControl: false,
    derivationKind: null,
    derivedFromDocumentId: null,
    hasRender: false,
    createdByUserName: null,
    updatedByUserName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupDocumentsByMap", () => {
  it("groups on the map version id, not the label", () => {
    // Two versions of the same town are different maps for authoring, so a shared label must not
    // collapse them — this is the one behaviour that differs from v1's label-keyed grouping.
    const groups = groupDocumentsByMap([
      summary({ id: "a", mapVersionId: "usmv_v1", mapLabel: "Richmond" }),
      summary({ id: "b", mapVersionId: "usmv_v2", mapLabel: "Richmond" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.mapVersionId).sort()).toEqual(["usmv_v1", "usmv_v2"]);
  });

  it("orders groups by their most recently edited document", () => {
    const groups = groupDocumentsByMap([
      summary({ id: "old", mapVersionId: "usmv_old", updatedAt: "2026-07-01T00:00:00.000Z" }),
      summary({ id: "new", mapVersionId: "usmv_new", updatedAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(groups.map((group) => group.mapVersionId)).toEqual(["usmv_new", "usmv_old"]);
  });

  it("orders documents inside a group newest-edited first", () => {
    const [group] = groupDocumentsByMap([
      summary({ id: "older", updatedAt: "2026-07-01T00:00:00.000Z" }),
      summary({ id: "newer", updatedAt: "2026-08-03T00:00:00.000Z" }),
    ]);
    expect(group?.documents.map((document) => document.id)).toEqual(["newer", "older"]);
  });

  it("prefers the map catalog's own label and thumbnail over the row's joined copy", () => {
    const [group] = groupDocumentsByMap(
      [summary({ mapLabel: "stale label" })],
      [{ mapVersionId: "usmv_a", sourceMapId: "map-a-source", label: "Map A v3", thumbnailUrl: "https://s3/presigned" }],
    );
    expect(group?.displayLabel).toBe("Map A v3");
    expect(group?.thumbnailUrl).toBe("https://s3/presigned");
  });

  it("keeps the exact-version preview when an older map is absent from the picker catalog", () => {
    const [group] = groupDocumentsByMap([
      summary({
        mapVersionId: "usmv_archived",
        mapThumbnailUrl: "/api/simforge/maps/usmv_archived/thumbnail",
      }),
    ]);

    expect(group?.thumbnailUrl).toBe("/api/simforge/maps/usmv_archived/thumbnail");
  });

  it("uses the stable exact-version route for a cached summary without preview metadata", () => {
    const [group] = groupDocumentsByMap([
      summary({ mapVersionId: "usmv_cached", mapThumbnailUrl: undefined }),
    ]);

    expect(group?.thumbnailUrl).toBe("/api/simforge/maps/usmv_cached/thumbnail");
  });

  it("uses the current catalog preview for an older version of the same source map", () => {
    const [group] = groupDocumentsByMap(
      [summary({ mapVersionId: "usmv_archived", mapSourceMapId: "map_asset_1" })],
      [{
        mapVersionId: "usmv_current",
        sourceMapId: "map_asset_1",
        label: "Map A",
        thumbnailUrl: "/api/simforge/maps/usmv_current/thumbnail",
      }],
    );

    expect(group?.thumbnailUrl).toBe("/api/simforge/maps/usmv_current/thumbnail");
  });

  it("uses an exact label match only as a presentation fallback for legacy maps", () => {
    const [group] = groupDocumentsByMap(
      [summary({ mapVersionId: "usmv_legacy", mapLabel: "Easterbrook", mapThumbnailUrl: null })],
      [{
        mapVersionId: "usmv_current",
        sourceMapId: "map_asset_1",
        label: "Easterbrook",
        thumbnailUrl: "/api/simforge/maps/usmv_current/thumbnail",
      }],
    );

    expect(group?.thumbnailUrl).toBe("/api/simforge/maps/usmv_current/thumbnail");
  });

  it("gives documents with no map their own stable group", () => {
    const groups = groupDocumentsByMap([
      summary({ id: "none", mapVersionId: null, mapLabel: null }),
    ]);
    expect(groups[0]?.groupKey).toBe("no-map");
    expect(groups[0]?.displayLabel).toBe("No map");
    expect(groups[0]?.thumbnailUrl).toBeNull();
  });

  it("ties on edit time break by label so the order is stable", () => {
    const groups = groupDocumentsByMap([
      summary({ id: "b", mapVersionId: "usmv_b", mapLabel: "Zulu" }),
      summary({ id: "a", mapVersionId: "usmv_a", mapLabel: "Alpha" }),
    ]);
    expect(groups.map((group) => group.displayLabel)).toEqual(["Alpha", "Zulu"]);
  });
});

describe("groupVariationsBySource", () => {
  it("nests only variation lineage kinds", () => {
    const bySource = groupVariationsBySource([
      summary({ id: "root" }),
      summary({ id: "v1", derivationKind: "variation", derivedFromDocumentId: "root" }),
      summary({ id: "v2", derivationKind: "cross_map_variation", derivedFromDocumentId: "root" }),
      // A copy is an independent document the user renamed and edited; nesting it would hide it from
      // the list it belongs to.
      summary({ id: "copy", derivationKind: "copy", derivedFromDocumentId: "root" }),
      summary({ id: "imported", derivationKind: "import", derivedFromDocumentId: "root" }),
    ]);
    expect(bySource.get("root")?.map((document) => document.id)).toEqual(["v1", "v2"]);
  });

  it("ignores a self-referential parent pointer", () => {
    const bySource = groupVariationsBySource([
      summary({ id: "self", derivationKind: "variation", derivedFromDocumentId: "self" }),
    ]);
    expect(bySource.size).toBe(0);
  });

  it("orders sub-rows by map, then creation, then id", () => {
    const bySource = groupVariationsBySource([
      summary({
        id: "z",
        derivationKind: "variation",
        derivedFromDocumentId: "root",
        mapLabel: "Zulu",
      }),
      summary({
        id: "a",
        derivationKind: "variation",
        derivedFromDocumentId: "root",
        mapLabel: "Alpha",
      }),
    ]);
    expect(bySource.get("root")?.map((document) => document.id)).toEqual(["a", "z"]);
  });
});
