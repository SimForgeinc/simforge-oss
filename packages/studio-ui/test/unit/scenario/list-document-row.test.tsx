// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { ScenarioDocumentSummaryDto } from "../../../src/lib/scenario/contracts";
import { ScenarioDocumentRow } from "../../../src/scenario/list/ScenarioDocumentRow";
import { ScenarioRating } from "../../../src/scenario/list/ScenarioRating";
import { StudioHostTestProvider } from "../../helpers/studio-host";

function summary(
  overrides: Partial<ScenarioDocumentSummaryDto> = {},
): ScenarioDocumentSummaryDto {
  return {
    id: "uscn_1",
    workspaceId: "ws_1",
    title: "Cut-in on the left",
    description: "Ego is overtaken at 48 kph.",
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
    createdByUserName: "Ada",
    updatedByUserName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Every row render, string or DOM, mounts under the host the row's export action reaches through. */
function rowElement(overrides: Partial<React.ComponentProps<typeof ScenarioDocumentRow>> = {}) {
  return (
    <StudioHostTestProvider>
      <ScenarioDocumentRow
        document={summary()}
        datasetId="usds_1"
        active={false}
        advancedMode={false}
        tagEditorMode={false}
        mutable
        busy={false}
        renaming={false}
        renameDraft=""
        renderInProgress={false}
        availableTags={[]}
        draggingTagId={null}
        draggingTagIdRef={createRef<string | null>() as React.MutableRefObject<string | null>}
        onClearDraggingTag={() => {}}
        onAssignTag={() => {}}
        onRenameDraftChange={() => {}}
        onSetRenamingDocumentId={() => {}}
        onCommitRename={() => {}}
        onOpenDocument={() => {}}
        onEditDocument={() => {}}
        onRenderDocument={() => {}}
        onDownloadDocument={() => {}}
        onDuplicateDocument={() => {}}
        onEditDetails={() => {}}
        onDeleteDocument={() => {}}
        onSetRating={() => {}}
        onError={() => {}}
        {...overrides}
      />
    </StudioHostTestProvider>
  );
}

function renderRow(overrides: Partial<React.ComponentProps<typeof ScenarioDocumentRow>> = {}) {
  return renderToString(rowElement(overrides));
}

afterEach(() => {
  cleanup();
});

describe("ScenarioDocumentRow", () => {
  it("renders the title and description in compact mode", () => {
    const html = renderRow();
    expect(html).toContain("Cut-in on the left");
    expect(html).toContain("Ego is overtaken at 48 kph.");
    expect(html).toContain('aria-label="Open Cut-in on the left"');
  });

  it("names an untitled document by its role count", () => {
    const html = renderRow({ document: summary({ title: "", roleCount: 4 }) });
    expect(html).toContain("Untitled Scenario (4 Roles)");
  });

  it("says so when a document has no description", () => {
    const html = renderRow({ document: summary({ description: null }) });
    expect(html).toContain("No description");
  });

  it("titles a variation sub-row by its map instead of repeating the name", () => {
    const html = renderRow({
      labelByMap: true,
      document: summary({ mapLabel: "Town10", derivationKind: "cross_map_variation" }),
    });
    expect(html).toContain("Town10");
    // The description is the parent's; repeating it under every sibling map is noise.
    expect(html).not.toContain("Ego is overtaken");
  });

  it("badges a variation in compact mode", () => {
    const html = renderRow({
      document: summary({ derivationKind: "variation", derivedFromDocumentId: "uscn_root" }),
    });
    expect(html).toContain("data-scenario-variation-tag");
    expect(html).toContain("Variation");
  });

  describe("advanced mode", () => {
    it("adds the editor line and rating widget without reserving a tag column", () => {
      const html = renderRow({
        advancedMode: true,
        document: summary({ createdByUserName: "Ada", updatedByUserName: "Grace" }),
      });
      expect(html).toContain("data-scenario-last-edited-by");
      expect(html).toContain("Last edited by: Grace");
      expect(html).toContain("data-scenario-edited-at");
      expect(html).not.toContain("data-scenario-tag-column");
      expect(html).toContain("grid-cols-[minmax(0,1fr)_auto]");
      expect(html).toContain("data-scenario-rating");
    });

    it("shows organizational tags as chips and content tags as read-only", () => {
      const html = renderRow({
        advancedMode: true,
        document: summary({
          tags: [{ id: "ustag_crash", label: "Crash", color: "#ef4444" }],
          contentTags: ["authored-tag"],
        }),
      });
      expect(html).toContain("Crash");
      expect(html).toContain("authored-tag");
      // A content tag lives inside `canonical_content` and is covered by content_sha256, so editing
      // one would change the document digest — it is labelled, not editable.
      expect(html).toContain("Authored in the scenario content");
      expect(html).toContain("border-dashed");
      expect(html).toContain("data-scenario-tag-pills");
      expect(html.indexOf("data-scenario-document-description")).toBeLessThan(
        html.indexOf("data-scenario-tag-pills"),
      );
    });

    it("does not render an empty tag row", () => {
      const html = renderRow({ advancedMode: true });
      expect(html).not.toContain("No tags");
      expect(html).not.toContain("data-scenario-tag-pills");
    });
  });

  describe("render state", () => {
    it("exposes the render action and routes a sensor-equipped scenario to rendering", () => {
      const rendered: string[] = [];
      render(
        rowElement({
          document: summary({ hasSensorProfile: true }),
          onRenderDocument: (document) => rendered.push(document.id),
        }),
      );
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Render Cut-in on the left",
      });
      expect(button.className.split(" ")).not.toContain("hidden");

      fireEvent.click(button);

      expect(rendered).toEqual(["uscn_1"]);
    });

    // Marked `aria-disabled`, not `disabled`. A `disabled` button receives no
    // pointer events, so neither a tooltip nor the native `title` ever fired —
    // clicking it did nothing and explained nothing, which is exactly how this
    // read as broken. It stays enabled to the browser so the reason is
    // reachable on hover and focus, and inert in the handler.
    it("refuses render when no actor has a sensor profile, and says why", async () => {
      const rendered: string[] = [];
      render(
        rowElement({
          document: summary({ hasSensorProfile: false }),
          onRenderDocument: (document) => rendered.push(document.id),
        }),
      );
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Render Cut-in on the left",
      });

      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("data-render-disabled-reason")).toBe("no-sensor-profile");

      fireEvent.click(button);
      expect(rendered).toEqual([]);

      // The reason has to be discoverable, not just encoded in a data attribute.
      fireEvent.focus(button);
      expect(
        await screen.findAllByText("Add a sensor profile to an actor before rendering"),
      ).not.toHaveLength(0);
    });

    it("enables render when an actor has a sensor profile", () => {
      const rendered: string[] = [];
      render(
        rowElement({
          document: summary({ hasSensorProfile: true }),
          onRenderDocument: (document) => rendered.push(document.id),
        }),
      );
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Render Cut-in on the left",
      });
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBeNull();

      fireEvent.click(button);
      expect(rendered).toEqual(["uscn_1"]);
    });

    it("reports a missing render", async () => {
      const html = renderRow();
      expect(html).toContain('data-render-state="missing"');
      expect(html).toContain("text-red-400");
    });

    // The state text moved out of `title` and into the tooltip, so that the
    // no-sensor-profile case can explain itself on a control the browser no
    // longer treats as disabled. Asserted through the tooltip for that reason.
    it("explains the render state on hover", async () => {
      render(rowElement());
      fireEvent.focus(
        screen.getByRole("button", { name: "Render Cut-in on the left" }),
      );
      expect(await screen.findAllByText("No render")).not.toHaveLength(0);
    });

    it("reports a completed render", () => {
      const html = renderRow({ document: summary({ hasRender: true }) });
      expect(html).toContain('data-render-state="complete"');
      expect(html).toContain("text-green-400");
    });

    it("reports a running render, which outranks a previous success", () => {
      const html = renderRow({ document: summary({ hasRender: true }), renderInProgress: true });
      expect(html).toContain('data-render-state="running"');
      expect(html).toContain("text-yellow-400");
    });
  });

  describe("variation toggle", () => {
    it("is absent when the document has no variations", () => {
      const html = renderRow({ variationCount: 0, onToggleVariations: () => {} });
      expect(html).not.toContain("data-scenario-variations-toggle");
    });

    it("stays hidden even with variations and an expanded state", () => {
      // Was asserting the opposite until 2026-08-04, when cross-map variations was dropped and the fork
      // toggle was gated off behind `SHOW_VARIATIONS_TOGGLE`. Kept rather than deleted because the props
      // still exist and still drive the grouped rows in the list body — it is only the row's own toggle
      // that is gone, and this is what would catch it coming back unintentionally.
      const html = renderRow({
        variationCount: 3,
        variationsExpanded: true,
        onToggleVariations: () => {},
      });
      expect(html).not.toContain("data-scenario-variations-toggle");
    });
  });

  it("labels the inline rename input", () => {
    const html = renderRow({ renaming: true, renameDraft: "Half-typed" });
    expect(html).toContain('aria-label="Rename Cut-in on the left"');
    expect(html).toContain("Half-typed");
  });

  describe("the action menu", () => {
    // Radix only mounts the menu content once it opens, so these have to run in the DOM rather than
    // against the server string. It opens on `pointerdown`, not on `click`.
    function openActionMenu(mutable: boolean) {
      render(rowElement({ mutable }));
      act(() => {
        fireEvent.pointerDown(
          screen.getByRole("button", { name: /Scenario actions/ }),
          { button: 0, ctrlKey: false, pointerType: "mouse" },
        );
      });
    }

    /** Radix marks a disabled item with `data-disabled` plus `aria-disabled`, not the DOM property. */
    function isDisabled(name: RegExp) {
      const item = screen.getByRole("menuitem", { name });
      return item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled");
    }

    it("disables edit-details and delete but leaves download, export and duplicate", () => {
      openActionMenu(false);
      expect(isDisabled(/Edit details/)).toBe(true);
      expect(isDisabled(/Delete/)).toBe(true);
      expect(isDisabled(/Download JSON/)).toBe(false);
      // Export is core in v2 and is a read of the dataset, so it survives read-only.
      expect(isDisabled(/Export OpenSCENARIO/)).toBe(false);
      // Duplicate writes to the destination dataset, not this one, so the row does not gate it.
      expect(isDisabled(/Duplicate/)).toBe(false);
    });

    it("enables the mutating entries on a writable dataset", () => {
      openActionMenu(true);
      expect(isDisabled(/Edit details/)).toBe(false);
      expect(isDisabled(/Delete/)).toBe(false);
    });

    it("offers no OpenSCENARIO import or replay entry — both are explicit drops", () => {
      openActionMenu(true);
      expect(screen.queryByRole("menuitem", { name: /Import/ })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: /Replay/ })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: /esmini/i })).toBeNull();
      // v1 also had "Export scenario package" (a zip) and "Preview" (a saved worker timeline);
      // neither has a v2 counterpart yet, so the menu is exactly these five.
      expect(screen.getAllByRole("menuitem")).toHaveLength(5);
    });
  });
});

describe("ScenarioRating", () => {
  function renderRating(props: Partial<React.ComponentProps<typeof ScenarioRating>> = {}) {
    return renderToString(
      <ScenarioRating documentName="Cut-in" onSetRating={() => {}} {...props} />,
    );
  }

  it("renders five radios in a labelled group", () => {
    const html = renderRating();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Rating for Cut-in"');
    expect(html.match(/role="radio"/g)).toHaveLength(5);
    expect(html).toContain('aria-label="1 star"');
    expect(html).toContain('aria-label="5 stars"');
  });

  it("marks the viewer's own score as checked and fills up to it", () => {
    const html = renderRating({
      aggregate: {
        documentId: "uscn_1",
        ratingCount: 2,
        averageScore: 4.5,
        minimumScore: 4,
        reviewState: "accepted",
        viewerScore: 3,
      },
    });
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/fill-current/g)).toHaveLength(3);
    expect(html).toContain("4.5 avg · 2");
  });

  it("reports having no ratings rather than showing a zero average", () => {
    expect(renderRating()).toContain("No ratings");
  });

  it("reports loading, saving and failure states in the aggregate slot", () => {
    expect(renderRating({ loading: true })).toContain("Loading");
    expect(renderRating({ saving: true })).toContain("Saving");
    expect(renderRating({ error: "nope" })).toContain("Rating unavailable");
  });

  it("badges a rejected review, which is any single score below four", () => {
    const html = renderRating({
      aggregate: {
        documentId: "uscn_1",
        ratingCount: 3,
        averageScore: 4.2,
        minimumScore: 2,
        reviewState: "rejected",
        viewerScore: null,
      },
    });
    expect(html).toContain("Rejected");
  });

  it("disables the stars while a write is in flight", () => {
    const html = renderRating({ saving: true });
    expect(html.match(/disabled=""/g)).toHaveLength(5);
  });
});

describe("the edit toggle", () => {
  /**
   * v1's pencil is a toggle, not a one-way trip: it reports whether this row is the open one and offers
   * the way back. v2 navigated instead, so the button had no state to show and no second press worth
   * making.
   */
  function pencil() {
    return screen.getByRole("button", { name: /^(Edit|Exit editor for) Cut-in on the left$/ });
  }

  it("is unpressed and reads as Edit when nothing is open", () => {
    render(rowElement());
    expect(pencil().getAttribute("aria-pressed")).toBe("false");
    expect(pencil().getAttribute("title")).toBe("Edit");
  });

  it("reports the open row as pressed and offers the way out", () => {
    render(rowElement({ editActive: true, onExitEdit: () => {} }));
    expect(pencil().getAttribute("aria-pressed")).toBe("true");
    expect(pencil().getAttribute("title")).toBe("Exit editor");
    // The name changes too: "Edit" on the row already being edited says the wrong thing.
    expect(pencil().getAttribute("aria-label")).toBe("Exit editor for Cut-in on the left");
  });

  it("opens the editor when pressed while closed", () => {
    const opened: string[] = [];
    render(rowElement({ onEditDocument: (document) => opened.push(document.id) }));
    fireEvent.click(pencil());
    expect(opened).toHaveLength(1);
  });

  it("exits instead of re-opening when pressed while open", () => {
    const opened: string[] = [];
    let exited = 0;
    render(
      rowElement({
        editActive: true,
        onEditDocument: (document) => opened.push(document.id),
        onExitEdit: () => {
          exited += 1;
        },
      }),
    );
    fireEvent.click(pencil());
    expect(exited).toBe(1);
    expect(opened).toEqual([]);
  });

  it("still opens when active but given no way out, rather than becoming a dead button", () => {
    // A host that sets `editActive` without `onExitEdit` is a mistake, but the recovery must not be a
    // button that silently does nothing.
    const opened: string[] = [];
    render(rowElement({ editActive: true, onEditDocument: (document) => opened.push(document.id) }));
    fireEvent.click(pencil());
    expect(opened).toHaveLength(1);
  });
});

describe("dropped affordances", () => {
  /**
   * Cross-map variations, the archive export-package and the old play preview were dropped on
   * 2026-08-04. Only the fork toggle ever existed in v2, so this is the one that needs a guard — the
   * other two are asserted absent so nobody re-adds them from the v1 row by accident.
   */
  it("does not offer the variations fork toggle, even with variations present", () => {
    render(rowElement({ variationCount: 3, onToggleVariations: () => {} }));
    expect(screen.queryByRole("button", { name: /variation/i })).toBeNull();
  });

  it("still offers edit and render, which were not dropped", () => {
    render(rowElement());
    expect(screen.getByRole("button", { name: /^Edit Cut-in on the left$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Render Cut-in on the left$/ })).toBeTruthy();
  });

  it("has no archive export-package or play-preview action", () => {
    const html = renderRow();
    expect(html).not.toMatch(/export scenario package/i);
    expect(html).not.toMatch(/play scenario/i);
  });
});

describe("render selection emphasis", () => {
  /**
   * With a render pane open beside the list, which scenario it belongs to has to be obvious. The row
   * carries that, since only the list knows which of its rows is the subject.
   */
  it("recedes a row while another scenario owns the render pane", () => {
    const html = renderRow({ renderDimmed: true });
    expect(html).toContain('data-render-dimmed="true"');
    expect(html).toContain("opacity-45");
    // Hover restores it: the author still has to be able to read the list to switch scenarios.
    expect(html).toContain("hover:opacity-100");
  });

  it("leaves the rendered scenario itself at full strength, and marks it", () => {
    const html = renderRow({ renderActive: true });
    expect(html).not.toContain("data-render-dimmed");
    expect(html).not.toContain("opacity-45");
    expect(html).toContain('data-render-active="true"');
  });

  it("dims nothing when no render pane is open", () => {
    const html = renderRow();
    expect(html).not.toContain("data-render-dimmed");
    expect(html).not.toContain("opacity-45");
  });
});
