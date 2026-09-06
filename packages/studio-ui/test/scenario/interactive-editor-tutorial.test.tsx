// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TutorialOverlaySlot } from "../../src/scenario/editor/regions/slots/TutorialOverlaySlot";
import { EditorTutorialGuide } from "../../src/scenario/editor/tutorial/EditorTutorialGuide";
import { CAMERA_ORBIT_EVENT } from "@simforge-oss/viewer";
import { tutorialStorageKey } from "../../src/scenario/editor/tutorial/tutorial-steps";
import { SIMPLE_ROUTE_TUTORIAL_STORAGE_KEY } from "../../src/scenario/editor/tutorial/simple-route-tutorial";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(tutorialStorageKey("simple"), "complete");
  localStorage.setItem(tutorialStorageKey("advanced"), "complete");
});

function TutorialHarness({
  actorCount = 1,
  configuredRouteCount = 0,
  customRouteTool = null,
  editorMode = "idle",
  experience = "advanced",
  interactionCount = 0,
  playbackInspecting = false,
  playbackPlaying = false,
}: {
  actorCount?: number;
  configuredRouteCount?: number;
  customRouteTool?: "add" | "move" | null;
  editorMode?: string;
  experience?: "simple" | "advanced";
  interactionCount?: number;
  playbackInspecting?: boolean;
  playbackPlaying?: boolean;
}) {
  return (
    <>
      <EditorTutorialGuide experience={experience} />
      <div data-tutorial="actor-library">
        <button data-testid="tool-vehicles" type="button">Car</button>
        <button data-testid="tool-pedestrians" type="button">Pedestrian</button>
      </div>
      <div data-testid="catalog-drawer">
        <button data-testid="catalog-action-sedan" type="button">Sedan</button>
      </div>
      <div data-testid="tutorial-canvas" data-tutorial="canvas" />
      <div data-tutorial="timeline">
        <button data-route-status="needs-setup" type="button">Configure route</button>
      </div>
      <TutorialOverlaySlot
        actorCount={actorCount}
        configuredRouteCount={configuredRouteCount}
        customRouteTool={customRouteTool}
        editorMode={editorMode}
        experience={experience}
        interactionCount={interactionCount}
        playbackInspecting={playbackInspecting}
        playbackPlaying={playbackPlaying}
        ready
      />
    </>
  );
}

function expectStep(title: string, action: string) {
  expect(screen.getByRole("heading", { name: title })).toBeTruthy();
  expect(screen.getByTestId("interactive-tutorial-card").getAttribute("data-action")).toBe(action);
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
}

describe("interactive editor tutorial", () => {
  it("advances only after real editor actions and successful state changes", () => {
    const view = render(<TutorialHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Tutorial" }));
    fireEvent.click(screen.getByRole("button", { name: "Start guided tutorial" }));

    expectStep("Move across the map", "move");
    fireEvent.click(screen.getByTestId("tool-vehicles"));
    expectStep("Move across the map", "move");
    fireEvent.keyDown(window, { code: "KeyW", key: "w" });

    expectStep("Orbit the camera", "orbit");
    expect(screen.queryByTestId("interactive-tutorial-spotlight")).toBeNull();
    fireEvent(window, new window.Event(CAMERA_ORBIT_EVENT));

    expectStep("Open the car library", "open-cars");
    fireEvent.click(screen.getByTestId("tool-vehicles"));
    expectStep("Choose a car", "choose-actor");
    fireEvent.click(screen.getByTestId("catalog-action-sedan"));

    expectStep("Place it on a road", "place-actor");
    view.rerender(<TutorialHarness actorCount={2} />);
    expectStep("Add an interaction", "add-action");
    view.rerender(<TutorialHarness actorCount={2} interactionCount={1} />);

    expectStep("Play the scenario", "play");
    view.rerender(
      <TutorialHarness
        actorCount={2}
        interactionCount={1}
        playbackInspecting
        playbackPlaying
      />,
    );
    expectStep("Reset to authoring", "exit-playback");
    view.rerender(<TutorialHarness actorCount={2} interactionCount={1} />);

    expectStep("You authored and ran a scenario", "finish");
    fireEvent.click(screen.getByRole("button", { name: "Continue authoring" }));
    expect(screen.queryByTestId("interactive-tutorial-overlay")).toBeNull();
  });

  it("requires Escape to leave active playback before teaching movement", () => {
    const view = render(<TutorialHarness playbackInspecting playbackPlaying />);
    fireEvent.click(screen.getByRole("button", { name: "Tutorial" }));
    fireEvent.click(screen.getByRole("button", { name: "Start guided tutorial" }));

    expectStep("Return to authoring", "reset");
    view.rerender(<TutorialHarness />);
    expectStep("Move across the map", "move");
  });

  it("teaches explicit timed-route configuration in simple mode", () => {
    localStorage.removeItem(tutorialStorageKey("simple"));
    const view = render(<TutorialHarness experience="simple" />);
    expectStep("Move across the map", "move");
    expect(localStorage.getItem(SIMPLE_ROUTE_TUTORIAL_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(tutorialStorageKey("simple"))).toBeNull();

    fireEvent.keyDown(window, { code: "KeyW", key: "w" });
    fireEvent(window, new window.Event(CAMERA_ORBIT_EVENT));
    expectStep("Open the pedestrian library", "open-pedestrians");
    fireEvent.click(screen.getByTestId("tool-pedestrians"));
    expectStep("Choose a pedestrian", "choose-actor");
    fireEvent.click(screen.getByTestId("catalog-action-sedan"));
    expectStep("Place the pedestrian", "place-actor");
    expect(screen.getByTestId("interactive-tutorial-card").style.left).toBe("16px");

    view.rerender(<TutorialHarness actorCount={2} experience="simple" />);
    expectStep("Open the route interaction", "configure-route");
    fireEvent.click(screen.getByRole("button", { name: "Configure route" }));
    expectStep("Open the route interaction", "configure-route");

    view.rerender(
      <TutorialHarness actorCount={2} editorMode="drawingRoute" experience="simple" />,
    );
    expectStep("Place one point per second", "draw-route");
    expect(screen.getByTestId("interactive-tutorial-card").style.bottom).toBe("24px");
    expect(screen.getByText(/Click directly on the highlighted last point again/i)).toBeTruthy();
    expect(screen.getByText(/Ctrl\+Z or Cmd\+Z to undo/i)).toBeTruthy();

    view.rerender(
      <TutorialHarness
        actorCount={2}
        configuredRouteCount={1}
        customRouteTool="add"
        editorMode="drawingRoute"
        experience="simple"
      />,
    );
    expectStep("Place one point per second", "draw-route");
    view.rerender(
      <TutorialHarness
        actorCount={2}
        configuredRouteCount={1}
        customRouteTool="move"
        editorMode="drawingRoute"
        experience="simple"
      />,
    );
    expectStep("Add a car", "open-cars");
    fireEvent.click(screen.getByTestId("tool-vehicles"));
    expectStep("Choose a car", "choose-actor");
    fireEvent.click(screen.getByTestId("catalog-action-sedan"));
    expectStep("Place the car", "place-actor");

    // The pedestrian placement must not satisfy the later car placement step.
    view.rerender(
      <TutorialHarness
        actorCount={2}
        configuredRouteCount={1}
        experience="simple"
      />,
    );
    expectStep("Place the car", "place-actor");
    view.rerender(
      <TutorialHarness
        actorCount={3}
        configuredRouteCount={1}
        experience="simple"
      />,
    );
    expectStep("Open the car route", "configure-route");
    view.rerender(
      <TutorialHarness
        actorCount={3}
        configuredRouteCount={1}
        customRouteTool="add"
        editorMode="drawingRoute"
        experience="simple"
      />,
    );
    expectStep("Draw the car route", "draw-route");
    view.rerender(
      <TutorialHarness
        actorCount={3}
        configuredRouteCount={2}
        customRouteTool="add"
        editorMode="drawingRoute"
        experience="simple"
      />,
    );
    expectStep("Draw the car route", "draw-route");
    view.rerender(
      <TutorialHarness
        actorCount={3}
        configuredRouteCount={2}
        customRouteTool="move"
        editorMode="drawingRoute"
        experience="simple"
      />,
    );
    expectStep("Play the scenario", "play");
    view.rerender(
      <TutorialHarness
        actorCount={3}
        configuredRouteCount={2}
        experience="simple"
        playbackInspecting
        playbackPlaying
      />,
    );
    expectStep("Reset to authoring", "exit-playback");
    view.rerender(
      <TutorialHarness actorCount={3} configuredRouteCount={2} experience="simple" />,
    );
    expectStep("You authored and ran a scenario", "finish");
    fireEvent.click(screen.getByRole("button", { name: "Continue authoring" }));
    expect(localStorage.getItem(tutorialStorageKey("simple"))).not.toBeNull();
  });

  it("closes an active walkthrough when the editor mode changes", () => {
    const view = render(<TutorialHarness experience="advanced" />);
    fireEvent.click(screen.getByRole("button", { name: "Tutorial" }));
    fireEvent.click(screen.getByRole("button", { name: "Start guided tutorial" }));
    expect(screen.getByTestId("interactive-tutorial-overlay")).toBeTruthy();

    view.rerender(<TutorialHarness experience="simple" />);
    expect(screen.queryByTestId("interactive-tutorial-overlay")).toBeNull();
  });
});
