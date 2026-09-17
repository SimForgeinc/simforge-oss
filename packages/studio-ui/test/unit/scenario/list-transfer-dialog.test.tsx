// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import { ScenarioTransferDialog } from "../../../src/scenario/list/ScenarioTransferDialog";
import { StudioHostTestProvider } from "../../helpers/studio-host";

const document: ScenarioDocumentSummaryDto = {
  id: "uscn_1",
  workspaceId: "ws_1",
  title: "Lane change",
  description: null,
  datasetId: "usds_1",
  datasetSortOrder: 0,
  mapVersionId: "usmv_1",
  mapLabel: "Source map",
  latestRevisionId: null,
  revisionCount: 0,
  archetype: null,
  author: null,
  contentTags: [],
  tags: [],
  roleCount: 2,
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
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("surfaces every structured lift refusal code to the reviewer", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      sourceMapVersionId: "usmv_1",
      sourceSiteId: null,
      lift: {
        ok: false,
        issues: [
          {
            code: "reference_lane_anchor_missing",
            severity: "error",
            path: "roles.ego",
            message: "The reference role has no lane anchor.",
          },
          {
            code: "route_turn_unbindable",
            severity: "error",
            message: "A route turn cannot be carried between maps.",
          },
        ],
      },
      maps: [],
    }),
  })) as typeof fetch);

  render(
    <StudioHostTestProvider>
      <ScenarioTransferDialog
        open
        document={document}
        busy={false}
        onClose={() => {}}
        onTransfer={async () => false}
      />
    </StudioHostTestProvider>,
  );

  expect(await screen.findByText("reference_lane_anchor_missing")).toBeTruthy();
  expect(screen.getByText("route_turn_unbindable")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("cannot be transferred");
  expect(screen.getByRole("button", { name: "Create variation" }).hasAttribute("disabled")).toBe(true);
});
