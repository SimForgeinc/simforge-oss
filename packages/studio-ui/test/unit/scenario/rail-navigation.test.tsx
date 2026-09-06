// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import { useScenarioRailNavigation } from "../../../src/scenario/rail/useScenarioRailNavigation";
import {
  resetScenarioListCache,
  scenarioListCache,
} from "../../../src/scenario/list/scenarioListCache";

const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace, prefetch: vi.fn() }),
}));

function summary(
  id: string,
  overrides: Partial<ScenarioDocumentSummaryDto> = {},
): ScenarioDocumentSummaryDto {
  return {
    id,
    workspaceId: "ws_1",
    title: id,
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

function setup({
  documents,
  activeDocumentId,
  replaceHistory = false,
  onSelect,
}: {
  documents: ScenarioDocumentSummaryDto[];
  activeDocumentId: string | null;
  replaceHistory?: boolean;
  onSelect?: (documentId: string) => void;
}) {
  return renderHook(() =>
    useScenarioRailNavigation({
      datasetId: "usds_1",
      documents,
      activeDocumentId,
      replaceHistory,
      onSelect,
    }),
  );
}

describe("useScenarioRailNavigation", () => {
  beforeEach(() => {
    resetScenarioListCache();
    push.mockReset();
    replace.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("orders documents by map, then newest-edited, then id", () => {
    const { result } = setup({
      documents: [
        summary("b-old", { mapLabel: "Bravo", updatedAt: "2026-07-01T00:00:00.000Z" }),
        summary("a", { mapLabel: "Alpha" }),
        summary("b-new", { mapLabel: "Bravo", updatedAt: "2026-08-03T00:00:00.000Z" }),
      ],
      activeDocumentId: null,
    });
    expect(result.current.orderedDocuments.map((item) => item.id)).toEqual([
      "a",
      "b-new",
      "b-old",
    ]);
  });

  it("navigates with both ids in the query and remembers the selection", () => {
    const { result } = setup({
      documents: [summary("a"), summary("b")],
      activeDocumentId: "a",
    });
    act(() => {
      result.current.selectDocument("b");
    });
    expect(push).toHaveBeenCalledTimes(1);
    const href = String(push.mock.calls[0]?.[0]);
    expect(href).toContain("/dashboard/scenario?");
    expect(new URL(href, "http://localhost").searchParams.get("dataset")).toBe("usds_1");
    expect(new URL(href, "http://localhost").searchParams.get("document")).toBe("b");
    expect(scenarioListCache.selectedDocumentIdByDataset.usds_1).toBe("b");
  });

  // The editor surface is keyed on the document id, so a route change would tear down the WebGL
  // context and re-stream the map for every scenario — once every six seconds under autoplay. When the
  // host gives us `onSelect`, the router must stay untouched.
  it("selects in place and never navigates when onSelect is given", () => {
    const onSelect = vi.fn();
    const { result } = setup({
      documents: [summary("a"), summary("b")],
      activeDocumentId: "a",
      onSelect,
    });
    act(() => {
      result.current.selectDocument("b");
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    // Still remembered, so a later reload reopens the scenario the reviewer left on.
    expect(scenarioListCache.selectedDocumentIdByDataset.usds_1).toBe("b");
  });

  it("keeps the keyboard and next/prev steps in place too", () => {
    const onSelect = vi.fn();
    const { result } = setup({
      documents: [summary("a"), summary("b"), summary("c")],
      activeDocumentId: "b",
      onSelect,
    });
    act(() => {
      result.current.selectNext();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true }));
    });
    expect(onSelect.mock.calls.map((call) => call[0])).toEqual(["c", "a"]);
    expect(push).not.toHaveBeenCalled();
  });

  it("does not navigate to the document already open", () => {
    const { result } = setup({ documents: [summary("a")], activeDocumentId: "a" });
    act(() => {
      result.current.selectDocument("a");
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("replaces instead of pushing when asked, so a review run does not bury history", () => {
    const { result } = setup({
      documents: [summary("a"), summary("b")],
      activeDocumentId: "a",
      replaceHistory: true,
    });
    act(() => {
      result.current.selectNext();
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  describe("prev / next", () => {
    it("exposes the neighbours of the active document", () => {
      const { result } = setup({
        documents: [summary("a"), summary("b"), summary("c")],
        activeDocumentId: "b",
      });
      expect(result.current.activeIndex).toBe(1);
      expect(result.current.previousDocument?.id).toBe("a");
      expect(result.current.nextDocument?.id).toBe("c");
    });

    it("stops at the ends rather than wrapping", () => {
      const first = setup({ documents: [summary("a"), summary("b")], activeDocumentId: "a" });
      expect(first.result.current.previousDocument).toBeNull();
      act(() => {
        first.result.current.selectPrevious();
      });
      expect(push).not.toHaveBeenCalled();
      cleanup();

      const last = setup({ documents: [summary("a"), summary("b")], activeDocumentId: "b" });
      expect(last.result.current.nextDocument).toBeNull();
      act(() => {
        last.result.current.selectNext();
      });
      expect(push).not.toHaveBeenCalled();
    });

    it("treats next as the first scenario when nothing is selected", () => {
      const { result } = setup({
        documents: [summary("a"), summary("b")],
        activeDocumentId: null,
      });
      expect(result.current.activeIndex).toBe(-1);
      act(() => {
        result.current.selectNext();
      });
      expect(new URL(String(push.mock.calls[0]?.[0]), "http://localhost").searchParams.get(
        "document",
      )).toBe("a");
    });
  });

  describe("keyboard", () => {
    function pressAlt(key: string, target?: HTMLElement) {
      act(() => {
        (target ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }),
        );
      });
    }

    it("steps with Alt+Arrow", () => {
      setup({ documents: [summary("a"), summary("b"), summary("c")], activeDocumentId: "b" });
      pressAlt("ArrowDown");
      expect(new URL(String(push.mock.calls[0]?.[0]), "http://localhost").searchParams.get(
        "document",
      )).toBe("c");
      push.mockReset();
      pressAlt("ArrowUp");
      expect(new URL(String(push.mock.calls[0]?.[0]), "http://localhost").searchParams.get(
        "document",
      )).toBe("a");
    });

    it("ignores a bare arrow, which belongs to the canvas", () => {
      setup({ documents: [summary("a"), summary("b")], activeDocumentId: "a" });
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      });
      expect(push).not.toHaveBeenCalled();
    });

    it("ignores keys typed into a field, so a rename keeps its caret", () => {
      setup({ documents: [summary("a"), summary("b")], activeDocumentId: "a" });
      const input = document.createElement("input");
      document.body.appendChild(input);
      pressAlt("ArrowDown", input);
      expect(push).not.toHaveBeenCalled();
      input.remove();
    });

    it("unbinds on unmount", () => {
      const { unmount } = setup({
        documents: [summary("a"), summary("b")],
        activeDocumentId: "a",
      });
      unmount();
      pressAlt("ArrowDown");
      expect(push).not.toHaveBeenCalled();
    });
  });
});
