/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EditorOverlayProvider,
  useEditorOverlay,
} from "../../src/scenario/editor/inspector/editor-overlay-selection";

afterEach(cleanup);

function SelectionHarness() {
  const { selection, actions } = useEditorOverlay();
  return (
    <>
      <output data-testid="selection">{JSON.stringify(selection)}</output>
      <button type="button" onClick={() => actions.selectActor("actor-a")}>actor</button>
      <button type="button" onClick={() => actions.selectInteraction("action-1", "actor-a")}>interaction</button>
      <button type="button" onClick={() => actions.clear()}>close</button>
    </>
  );
}

describe("EditorOverlayProvider", () => {
  it("keeps actor and interaction details mutually exclusive and clears actor focus for clips", () => {
    const onSelectActor = vi.fn();
    const view = render(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId="actor-a"
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );

    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: "actor", actorId: "actor-a" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "interaction" }));
    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: "interaction", interactionId: "action-1", actorId: "actor-a" }),
    );
    expect(onSelectActor).toHaveBeenLastCalledWith(null);

    view.rerender(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId={null}
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: "interaction", interactionId: "action-1", actorId: "actor-a" }),
    );

    view.rerender(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId="actor-b"
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: "actor", actorId: "actor-b" }),
    );
  });

  it("clears the UI selection when the open document changes", () => {
    const onSelectActor = vi.fn();
    const view = render(
      <EditorOverlayProvider documentKey="doc-a" selectedActorId={null} onSelectActor={onSelectActor}>
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "interaction" }));
    view.rerender(
      <EditorOverlayProvider documentKey="doc-b" selectedActorId={null} onSelectActor={onSelectActor}>
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: null }),
    );
    expect(onSelectActor).toHaveBeenLastCalledWith(null);
  });

  it("does not open actor details for the operational selection used by route drawing", () => {
    const onSelectActor = vi.fn();
    const view = render(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId={null}
        suppressActorDetails={false}
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );

    view.rerender(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId="actor-a"
        suppressActorDetails
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    expect(screen.getByTestId("selection").textContent).toBe(JSON.stringify({ kind: null }));

    view.rerender(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId="actor-a"
        suppressActorDetails={false}
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    expect(screen.getByTestId("selection").textContent).toBe(JSON.stringify({ kind: null }));

    fireEvent.click(screen.getByRole("button", { name: "actor" }));
    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: "actor", actorId: "actor-a" }),
    );
  });
  /**
   * The camera stops following a car when the car stops being selected, and it reads that from the
   * controller's actor selection. Closing the details panel is one of the two ways an author lets go
   * of a car, so it has to reach the same clear the unclick does — otherwise the camera keeps
   * tracking a car with no panel and no selection ring to show for it.
   */
  it("clears the controller's actor selection when the details panel closes", () => {
    const onSelectActor = vi.fn();
    render(
      <EditorOverlayProvider
        documentKey="doc-a"
        selectedActorId="actor-a"
        onSelectActor={onSelectActor}
      >
        <SelectionHarness />
      </EditorOverlayProvider>,
    );
    expect(screen.getByTestId("selection").textContent).toBe(
      JSON.stringify({ kind: "actor", actorId: "actor-a" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    expect(onSelectActor).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("selection").textContent).toBe(JSON.stringify({ kind: null }));
  });
});
