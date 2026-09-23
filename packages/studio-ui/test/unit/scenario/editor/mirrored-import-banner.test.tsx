// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MirroredImportBanner } from "../../../../src/scenario/editor/MirroredImportBanner";
import {
  applyMirroredImportRepair,
  mirroredImportBannerModel,
  type RepairableDocument,
} from "../../../../src/scenario/editor/mirrored-import-repair";

afterEach(cleanup);

const IMPORTED_AT = "2026-09-20T10:00:00.000Z";

/** What the pre-b79130bb importer wrote: scene z = +y_osc. */
function mirroredImport(extraRoles: unknown[] = []): ScenarioTemplateV2 {
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name: "cut-in", createdAt: IMPORTED_AT, modifiedAt: IMPORTED_AT, appVersion: "xosc-import/v1", tags: ["openscenario-import"] },
    sourceMap: { mapId: "town04", mapName: "Town04" },
    anchor: { id: "imported_scene", pin: { mapId: "town04" } },
    roles: [
      { id: "Ego", kind: "scene_absolute", label: "Ego", actor: { class: "car", static: false }, pose: { position: { x: 10, y: 0, z: 12.5 }, headingRad: 1.2 } },
      { id: "Lead", kind: "scene_absolute", label: "Lead", actor: { class: "car", static: false }, pose: { position: { x: 30, y: 0, z: 12.5 }, headingRad: 1.2 } },
      ...extraRoles,
    ],
    choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [] },
    extensions: {
      openScenarioImport: {
        version: 1,
        importedAt: IMPORTED_AT,
        report: { diagnostics: [{ code: "world_positions_preserved", message: "3 actor world positions preserved exactly in a map-pinned v2 draft." }] },
      },
    },
  });
}

function fakeDocument(data: ScenarioTemplateV2) {
  const applyRepair = vi.fn<RepairableDocument["applyRepair"]>();
  return { data, applyRepair } satisfies RepairableDocument;
}

describe("mirroredImportBannerModel", () => {
  it("offers the imported roles and names only the imported ones the author edited", () => {
    const model = mirroredImportBannerModel(mirroredImport([
      { id: "Walker", kind: "scene_absolute", actor: { class: "pedestrian", static: false }, pose: { position: { x: 1, y: 0, z: 2 }, headingRad: 0 }, laneRef: { roadId: "1", section: 0, laneId: -1, s: 1, t: 0, headingOffsetRad: 0 } },
      { id: "Opposing", kind: "on_reference", actor: { class: "car", static: false }, pose: { laneOffset: 0, s: 10 } },
    ]));
    expect(model).toEqual({ roleIds: ["Ego", "Lead"], keptEdited: [{ id: "Walker", reason: "lane_anchored" }] });
  });

  it("offers nothing for documents that were never imported or are already fixed", () => {
    expect(mirroredImportBannerModel(null)).toBeNull();
    const { extensions: _drop, ...plain } = mirroredImport();
    expect(mirroredImportBannerModel(parseTemplate(plain))).toBeNull();
    const fixed = mirroredImport();
    const block = fixed.extensions!.openScenarioImport as Record<string, unknown>;
    expect(mirroredImportBannerModel({ ...fixed, extensions: { openScenarioImport: { ...block, mirrorFix: { version: 1 } } } })).toBeNull();
  });
});

describe("applyMirroredImportRepair", () => {
  it("hands the editor exactly the repaired roles and the marked provenance block", () => {
    const document = fakeDocument(mirroredImport());
    expect(applyMirroredImportRepair(document, new Date("2026-09-23T00:00:00.000Z"))).toBe(true);
    expect(document.applyRepair).toHaveBeenCalledOnce();
    const [repair] = document.applyRepair.mock.calls[0]!;
    expect(repair.roles?.map((role) => role.kind === "scene_absolute" && [role.id, role.pose.position.z, role.pose.headingRad])).toEqual([
      ["Ego", -12.5, 1.2],
      ["Lead", -12.5, 1.2],
    ]);
    expect(repair.extensions).toEqual({
      openScenarioImport: {
        ...(document.data.extensions!.openScenarioImport as object),
        mirrorFix: { version: 1, appliedAt: "2026-09-23T00:00:00.000Z", roles: ["Ego", "Lead"], skipped: [] },
      },
    });
  });

  it("does nothing to a document that does not need it", () => {
    const { extensions: _drop, ...plain } = mirroredImport();
    const document = fakeDocument(parseTemplate(plain));
    expect(applyMirroredImportRepair(document)).toBe(false);
    expect(document.applyRepair).not.toHaveBeenCalled();
  });
});

describe("MirroredImportBanner", () => {
  it("explains the problem and fixes only after the author confirms", () => {
    const document = fakeDocument(mirroredImport());
    render(<MirroredImportBanner document={document} />);

    expect(screen.getByText(/older importer that placed actors mirrored/i).textContent).toContain("east-west axis");
    fireEvent.click(screen.getByRole("button", { name: "Fix 2 positions" }));
    expect(document.applyRepair).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Fix 2 imported actor positions?");
    expect(dialog.textContent).toContain("new draft version");
    expect(screen.getByRole("list", { name: "Actors that move" }).textContent).toBe("EgoLead");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.applyRepair).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Fix 2 positions" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix positions" }));
    expect(document.applyRepair).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be put off for the session and is absent where nothing needs fixing", () => {
    const document = fakeDocument(mirroredImport());
    const { rerender } = render(<MirroredImportBanner document={document} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("mirrored-import-banner")).toBeNull();

    const { extensions: _drop, ...plain } = mirroredImport();
    rerender(<MirroredImportBanner key="plain" document={fakeDocument(parseTemplate(plain))} />);
    expect(screen.queryByTestId("mirrored-import-banner")).toBeNull();
    rerender(<MirroredImportBanner key="none" document={null} />);
    expect(screen.queryByTestId("mirrored-import-banner")).toBeNull();
  });
});
