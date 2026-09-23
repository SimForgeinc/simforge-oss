/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Interaction } from "@simforge-oss/scenario";

const positionSpy = vi.hoisted(() => vi.fn());
vi.mock(
  "../../src/lib/scenario/editor/anchored-popover",
  () => ({
    useAnchoredPopoverPosition: (options: unknown) => {
      positionSpy(options);
      return { anchorVisible: true, placement: null };
    },
  }),
);
vi.mock(
  "../../src/scenario/editor/inspector/ActorDetailsPanel",
  () => ({
    ActorDetailsPanel: ({ actor, showMotionControls }: { actor: { id: string }; showMotionControls?: boolean }) => (
      <div
        data-actor-id={actor.id}
        data-motion-controls={String(showMotionControls)}
        data-testid="actor-details-panel-stub"
      />
    ),
  }),
);

import { EditorOverlayHost } from "../../src/scenario/editor/inspector/EditorOverlayHost";
import { EditorPlayerModeProvider } from "../../src/scenario/editor/player/player-mode";
import {
  EditorOverlayProvider,
  useEditorOverlay,
} from "../../src/scenario/editor/inspector/editor-overlay-selection";
import type { EditorDocument } from "@simforge-oss/editor";

afterEach(cleanup);
beforeEach(() => positionSpy.mockClear());

const interaction: Interaction = {
  id: "speed-1",
  actor: "ego",
  trigger: { kind: "at", t: 3 },
  until: { kind: "at", t: 4 },
  verb: "speed",
  target: { mode: "absolute", valueKph: 48 },
  dynamics: { shape: "linear", constraint: "time", value: 1 },
};

function makeDocument() {
  const listeners = new Set<() => void>();
  let revision = 1;
  const data = {
    roles: [{ id: "ego", label: "Ego" }],
    choreography: { interactions: [interaction], clipSeconds: 10, warmupSeconds: 0 },
  };
  const actor = { id: "ego" };
  const emit = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const document = {
    data,
    get revision() {
      return revision;
    },
    actor: vi.fn((id: string) => id === actor.id ? actor : undefined),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replaceInteraction: vi.fn((id: string, next: Interaction) => {
      const index = data.choreography.interactions.findIndex((item) => item.id === id);
      data.choreography.interactions[index] = next;
      emit();
    }),
    removeInteraction: vi.fn((id: string) => {
      data.choreography.interactions = data.choreography.interactions.filter((item) => item.id !== id);
      emit();
    }),
    removeExternally(id: string) {
      data.choreography.interactions = data.choreography.interactions.filter((item) => item.id !== id);
      emit();
    },
  };
  return document;
}

function OverlayButtons() {
  const { actions, selection } = useEditorOverlay();
  return (
    <>
      <output data-testid="active-overlay-kind">{selection.kind ?? "none"}</output>
      <button type="button" onClick={() => actions.selectInteraction("speed-1", "ego")}>open action</button>
    </>
  );
}

function Fixture({ document }: { document: ReturnType<typeof makeDocument> }) {
  return (
    <EditorOverlayProvider
      documentKey={document}
      selectedActorId={null}
      onSelectActor={vi.fn()}
    >
      <div data-testid="scenario-editor-canvas-region" />
      <div data-timeline-interaction-id="speed-1" />
      <OverlayButtons />
      <EditorOverlayHost
        controller={null}
        document={document as unknown as EditorDocument}
      />
    </EditorOverlayProvider>
  );
}

describe("EditorOverlayHost", () => {
  it("mounts the fixed actor details panel for actor selection", () => {
    const document = makeDocument();
    render(
      <EditorOverlayProvider
        documentKey={document}
        selectedActorId="ego"
        onSelectActor={vi.fn()}
      >
        <EditorOverlayHost
          controller={null}
          document={document as unknown as EditorDocument}
          showActorMotionControls={false}
        />
      </EditorOverlayProvider>,
    );

    expect(screen.getByTestId("actor-details-panel-stub").getAttribute("data-actor-id")).toBe("ego");
    expect(screen.getByTestId("actor-details-panel-stub").getAttribute("data-motion-controls")).toBe("false");
  });

  it("opens the action editor in the universal details panel and preserves rich v2 values", async () => {
    const document = makeDocument();
    render(<Fixture document={document} />);
    fireEvent.click(screen.getByRole("button", { name: "open action" }));

    await screen.findByTestId("scenario-interaction-popover");
    fireEvent.change(screen.getByLabelText("Target speed (kph)"), {
      target: { value: "55.5" },
    });
    expect(document.replaceInteraction).toHaveBeenLastCalledWith(
      "speed-1",
      expect.objectContaining({
        trigger: { kind: "at", t: 3 },
        until: { kind: "at", t: 4 },
        target: { mode: "absolute", valueKph: 55.5 },
      }),
    );
  });

  it("closes the action editor on Escape", async () => {
    const document = makeDocument();
    render(<Fixture document={document} />);
    fireEvent.click(screen.getByRole("button", { name: "open action" }));
    expect(await screen.findByTestId("scenario-interaction-popover")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("scenario-interaction-popover")).toBeNull();
  });

  it("steps the open panel aside while the simulation player owns the viewport, and brings it back", async () => {
    const document = makeDocument();
    const view = render(
      <EditorPlayerModeProvider playing={false}>
        <Fixture document={document} />
      </EditorPlayerModeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "open action" }));
    const panel = await screen.findByTestId("scenario-interaction-popover");
    expect(panel.hasAttribute("inert")).toBe(false);

    view.rerender(
      <EditorPlayerModeProvider playing>
        <Fixture document={document} />
      </EditorPlayerModeProvider>,
    );
    // Hidden, not unmounted: the very same element, no blocking sign.
    const hidden = screen.getByTestId("scenario-interaction-popover");
    expect(hidden).toBe(panel);
    expect(hidden.hasAttribute("inert")).toBe(true);
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.hasAttribute("data-player-hidden")).toBe(true);
    expect(screen.queryByText(/Cancel simulation first/)).toBeNull();
    expect(screen.queryByText(/Press Esc to cancel simulation/)).toBeNull();

    // Keys belong to the player: Escape leaves the panel, Delete deletes nothing.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Delete" });
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(document.removeInteraction).not.toHaveBeenCalled();
    expect(screen.getByTestId("active-overlay-kind").textContent).toBe("interaction");

    view.rerender(
      <EditorPlayerModeProvider playing={false}>
        <Fixture document={document} />
      </EditorPlayerModeProvider>,
    );
    const restored = screen.getByTestId("scenario-interaction-popover");
    expect(restored).toBe(panel);
    expect(restored.hasAttribute("inert")).toBe(false);
    expect(restored.hasAttribute("data-player-hidden")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("scenario-interaction-popover")).toBeNull();
  });

  it.each(["Delete", "Backspace"])(
    "deletes only the open interaction when %s is pressed",
    async (key) => {
      const document = makeDocument();
      render(<Fixture document={document} />);
      fireEvent.click(screen.getByRole("button", { name: "open action" }));
      expect(await screen.findByTestId("scenario-interaction-popover")).toBeTruthy();

      fireEvent.keyDown(window, { key });

      expect(document.removeInteraction).toHaveBeenCalledExactlyOnceWith("speed-1");
      expect(screen.queryByTestId("scenario-interaction-popover")).toBeNull();
    },
  );

  it("leaves Backspace available inside details-panel fields", async () => {
    const document = makeDocument();
    render(<Fixture document={document} />);
    fireEvent.click(screen.getByRole("button", { name: "open action" }));
    const targetSpeed = await screen.findByLabelText("Target speed (kph)");

    fireEvent.keyDown(targetSpeed, { key: "Backspace" });

    expect(document.removeInteraction).not.toHaveBeenCalled();
  });

  it("clears a stale selection when its document entity is deleted", async () => {
    const document = makeDocument();
    render(<Fixture document={document} />);
    fireEvent.click(screen.getByRole("button", { name: "open action" }));
    expect(await screen.findByTestId("scenario-interaction-popover")).toBeTruthy();

    document.removeExternally("speed-1");
    await waitFor(() => {
      expect(screen.getByTestId("active-overlay-kind").textContent).toBe("none");
    });
    expect(screen.queryByTestId("scenario-interaction-popover")).toBeNull();
  });

});
