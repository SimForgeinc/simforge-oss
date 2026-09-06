// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TutorialOverlay } from "../../src/scenario/editor/tutorial/TutorialOverlay";
import { TutorialOverlaySlot } from "../../src/scenario/editor/regions/slots/TutorialOverlaySlot";
import {
  ADVANCED_TUTORIAL_STEPS,
  SIMPLE_TUTORIAL_STEPS,
  reachableSteps,
  shouldRunTutorial,
  tutorialStorageKey,
} from "../../src/scenario/editor/tutorial/tutorial-steps";

afterEach(() => {
  cleanup();
  localStorage.clear();
  // `cleanup()` unmounts React roots but leaves nodes appended by hand, and a
  // leaked anchor changes the *step count* of the next test — which is exactly
  // what this suite asserts on.
  document
    .querySelectorAll("[data-tutorial]")
    .forEach((node) => node.remove());
});

function anchor(name: string) {
  const node = document.createElement("div");
  node.setAttribute("data-tutorial", name);
  document.body.appendChild(node);
  return node;
}

describe("tutorial step model", () => {
  it("skips steps whose anchor is not mounted, since regions mount conditionally", () => {
    expect(reachableSteps(SIMPLE_TUTORIAL_STEPS, (name) => name === "canvas")
      .map((step) => step.id)).toEqual(["welcome", "canvas"]);
    expect(reachableSteps(ADVANCED_TUTORIAL_STEPS, (name) => name === "canvas")
      .map((step) => step.id)).toEqual(["welcome", "canvas"]);
  });

  it("tracks completion separately for each mode and tolerates unavailable storage", () => {
    expect(shouldRunTutorial(localStorage, "simple")).toBe(true);
    expect(shouldRunTutorial(localStorage, "advanced")).toBe(true);
    localStorage.setItem(tutorialStorageKey("simple"), "2026-08-05T00:00:00.000Z");
    expect(shouldRunTutorial(localStorage, "simple")).toBe(false);
    expect(shouldRunTutorial(localStorage, "advanced")).toBe(true);

    // A private-mode browser that throws must not replay the tour forever.
    const throwing = {
      getItem() {
        throw new Error("SecurityError");
      },
    };
    expect(shouldRunTutorial(throwing, "advanced")).toBe(false);
    expect(shouldRunTutorial(null, "advanced")).toBe(false);
  });
});

describe("TutorialOverlay", () => {
  it("steps with the arrow keys and closes on Escape without a pointer", () => {
    anchor("actor-library");
    const onClose = vi.fn();
    render(<TutorialOverlay mode="advanced" onClose={onClose} />);

    expect(screen.getByText(/Step 1 of 2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText(/Step 2 of 2/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText(/Step 1 of 2/)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem(tutorialStorageKey("advanced"))).not.toBeNull();
  });

  it("records completion when finished, so it never reappears", () => {
    const onClose = vi.fn();
    render(<TutorialOverlay mode="simple" onClose={onClose} />);

    // No anchors in the DOM, so only the anchorless welcome step is reachable
    // and it is therefore also the last one.
    expect(screen.getByText(/Step 1 of 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start authoring" }));

    expect(onClose).toHaveBeenCalled();
    expect(shouldRunTutorial(localStorage, "simple")).toBe(false);
  });

  it("records completion when skipped, because a skip is a decision", () => {
    render(<TutorialOverlay mode="advanced" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip the walkthrough" }));
    expect(shouldRunTutorial(localStorage, "advanced")).toBe(false);
  });

  it("is a labelled dialog and disables Back on the first step", () => {
    render(<TutorialOverlay mode="advanced" onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe("scenario-tutorial-title");
    expect(
      (screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("TutorialOverlaySlot", () => {
  it("stays closed until the editor is ready", () => {
    const { rerender } = render(<TutorialOverlaySlot experience="simple" ready={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(<TutorialOverlaySlot experience="simple" ready />);
    expect(screen.getByTestId("interactive-tutorial-overlay")).toBeTruthy();
  });

  it("stays closed for a browser that has already been walked through", () => {
    localStorage.setItem(tutorialStorageKey("advanced"), "2026-08-05T00:00:00.000Z");
    render(<TutorialOverlaySlot experience="advanced" ready />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the walkthrough again when entering an incomplete mode", () => {
    localStorage.setItem(tutorialStorageKey("advanced"), "complete");
    const view = render(<TutorialOverlaySlot experience="advanced" ready />);
    expect(screen.queryByRole("dialog")).toBeNull();

    view.rerender(<TutorialOverlaySlot experience="simple" ready />);
    expect(screen.getByTestId("interactive-tutorial-overlay")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Move across the map" })).toBeTruthy();
  });

  it("does not set completion when dismissed and retries on the next scenario", () => {
    const view = render(
      <TutorialOverlaySlot experience="simple" ready scenarioKey="scenario-a" />,
    );
    expect(screen.getByTestId("interactive-tutorial-overlay")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit interactive tutorial" }));
    expect(localStorage.getItem(tutorialStorageKey("simple"))).toBeNull();

    view.rerender(
      <TutorialOverlaySlot experience="simple" ready scenarioKey="scenario-b" />,
    );
    expect(screen.getByTestId("interactive-tutorial-overlay")).toBeTruthy();
  });
});
