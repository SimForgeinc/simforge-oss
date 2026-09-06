import { describe, expect, it } from "vitest";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import {
  documentCreatorKey,
  documentEditedAtLabel,
  documentEditedAtMs,
  documentLastEditorName,
  documentMapLabel,
  documentName,
  documentSummaryFromDocument,
  formatDocumentCoverage,
  formatLastUpdated,
  formatRelativeEditedAge,
  updateDocumentList,
} from "../../../src/scenario/list/document-list-utils";

function summary(
  overrides: Partial<ScenarioDocumentSummaryDto> = {},
): ScenarioDocumentSummaryDto {
  return {
    id: "uscn_1",
    workspaceId: "ws_1",
    title: "Cut-in on the left",
    description: null,
    datasetId: "usds_1",
    datasetSortOrder: 0,
    mapVersionId: "usmv_1",
    mapLabel: "Richmond",
    latestRevisionId: null,
    revisionCount: 0,
    archetype: null,
    author: null,
    contentTags: [],
    tags: [],
    roleCount: 2,
    hasSensorProfile: true,
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
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("document naming and labels", () => {
  it("falls back to a role count when a document has no title", () => {
    expect(documentName(summary({ title: "  ", roleCount: 3 }))).toBe("Untitled Scenario (3 Roles)");
    expect(documentName(summary({ title: "", roleCount: 1 }))).toBe("Untitled Scenario (1 Role)");
  });

  it("prefers the joined map label, then the id, then a placeholder", () => {
    expect(documentMapLabel(summary())).toBe("Richmond");
    expect(documentMapLabel(summary({ mapLabel: null }))).toBe("usmv_1");
    expect(documentMapLabel(summary({ mapLabel: null, mapVersionId: null }))).toBe("No map");
  });

  it("reports the most recent editor, falling back to the author", () => {
    expect(
      documentLastEditorName(summary({ createdByUserName: "Ada", updatedByUserName: "Grace" })),
    ).toBe("Grace");
    expect(documentLastEditorName(summary({ createdByUserName: "Ada" }))).toBe("Ada");
    expect(documentLastEditorName(summary())).toBeNull();
  });

  it("uses updated_at for edited-age, falling back to created_at", () => {
    expect(documentEditedAtMs(summary())).toBe(Date.parse("2026-08-02T00:00:00.000Z"));
    expect(documentEditedAtMs(summary({ updatedAt: "not-a-date" }))).toBe(
      Date.parse("2026-08-01T00:00:00.000Z"),
    );
    expect(documentEditedAtMs(summary({ updatedAt: "nope", createdAt: "nope" }))).toBe(0);
  });

  it("formats relative age in minutes then hours", () => {
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    expect(formatRelativeEditedAge(now - 60_000, now)).toBe("1 minute ago");
    expect(formatRelativeEditedAge(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelativeEditedAge(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(formatRelativeEditedAge(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
    // A clock skew that puts the edit in the future must not read as "-4 minutes ago".
    expect(formatRelativeEditedAge(now + 60_000, now)).toBe("1 minute ago");
  });

  it("builds the absolute-plus-relative edited label", () => {
    const now = Date.parse("2026-08-02T02:00:00.000Z");
    expect(documentEditedAtLabel(summary(), now)).toBe("Aug 2, 2026 · 2 hours ago");
    expect(documentEditedAtLabel(summary({ updatedAt: "x", createdAt: "x" }), now)).toBeNull();
  });

  it("formats coverage and last-updated for the dataset columns", () => {
    expect(formatDocumentCoverage(3, 12)).toBe("3 / 12");
    expect(formatLastUpdated(null)).toBe("Never");
    expect(formatLastUpdated("not-a-date")).toBe("Unknown");
    expect(formatLastUpdated("2026-08-02T00:00:00.000Z")).toContain("2026");
  });

  it("keys the creator filter on the display name, or nothing", () => {
    expect(documentCreatorKey(summary({ createdByUserName: " Ada " }))).toBe("Ada");
    expect(documentCreatorKey(summary({ createdByUserName: "   " }))).toBeNull();
  });
});

describe("updateDocumentList", () => {
  it("merges an existing row in place", () => {
    const list = [summary({ id: "a", title: "A" }), summary({ id: "b", title: "B" })];
    const next = updateDocumentList(list, summary({ id: "b", title: "B2" }));
    expect(next.map((item) => `${item.id}:${item.title}`)).toEqual(["a:A", "b:B2"]);
  });

  it("prepends a row it has never seen", () => {
    const next = updateDocumentList([summary({ id: "a" })], summary({ id: "z", title: "Z" }));
    expect(next.map((item) => item.id)).toEqual(["z", "a"]);
  });

  it("treats an absent list as empty", () => {
    expect(updateDocumentList(undefined, summary({ id: "a" })).map((item) => item.id)).toEqual(["a"]);
  });
});

describe("documentSummaryFromDocument", () => {
  it("reads the template counts off content so a new row is not blank", () => {
    const projected = documentSummaryFromDocument({
      id: "uscn_new",
      workspaceId: "ws_1",
      title: "Fresh",
      datasetId: "usds_1",
      mapVersionId: "usmv_1",
      latestRevisionId: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      content: {
        meta: { description: " a description ", tags: ["crash"], archetype: "cut_in" },
        roles: [{}, {}, {}],
        props: [{}],
        variants: [],
      },
    });
    expect(projected.roleCount).toBe(3);
    expect(projected.propCount).toBe(1);
    expect(projected.variantCount).toBe(0);
    expect(projected.description).toBe("a description");
    expect(projected.archetype).toBe("cut_in");
    // `contentTags` is the template's authored `meta.tags`; organizational `tags` starts empty.
    expect(projected.contentTags).toEqual(["crash"]);
    expect(projected.tags).toEqual([]);
  });

  it("tolerates a template with no meta and no collections", () => {
    const projected = documentSummaryFromDocument({
      id: "uscn_new",
      workspaceId: "ws_1",
      title: "Fresh",
      datasetId: "usds_1",
      mapVersionId: null,
      latestRevisionId: null,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      content: {},
    });
    expect(projected.roleCount).toBe(0);
    expect(projected.description).toBeNull();
    expect(projected.contentTags).toEqual([]);
  });
});
