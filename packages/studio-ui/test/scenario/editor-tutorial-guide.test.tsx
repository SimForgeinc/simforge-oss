// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EditorTutorialGuide } from "../../src/scenario/editor/tutorial/EditorTutorialGuide";

afterEach(cleanup);

function openWrittenGuide() {
  fireEvent.click(screen.getByRole("button", { name: "Tutorial" }));
  expect(screen.getByRole("dialog", { name: "How would you like to learn?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open written guide" }));
}

describe("EditorTutorialGuide", () => {
  it("opens a modal viewport guide with controls first and the complete authoring flow", () => {
    render(<EditorTutorialGuide experience="advanced" />);

    openWrittenGuide();
    const dialog = screen.getByRole("dialog", { name: "Editor tutorial · Advanced" });
    // The backdrop owns the overlay: the guide is rendered inside it, at the top of the
    // document rather than inline in the editor, and it takes the page over as a modal.
    const backdrop = screen.getByTestId("editor-tutorial-backdrop");
    expect(backdrop.contains(dialog)).toBe(true);
    expect(backdrop.parentElement).toBe(document.body);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(dialog).getByRole("button", { name: "Start advanced interactive tutorial" })).toBeTruthy();

    const controls = within(dialog).getByRole("heading", { name: "Controls" });
    const actors = within(dialog).getByRole("heading", { name: "Place actors" });
    expect(controls.compareDocumentPosition(actors) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const key of ["Esc", "Space", "W", "A", "S", "D"]) {
      expect(within(dialog).getByText(key, { selector: "kbd" })).toBeTruthy();
    }
    expect(within(dialog).getByText("Left-drag")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Tune the viewport in Settings" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Render quality" })).toBeTruthy();
    expect(within(dialog).getByText(/Adjust Look X\/Y/)).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Configure the timeline" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Run the simulation" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Imports" })).toBeTruthy();
    expect(within(dialog).getByText("Scenario JSON")).toBeTruthy();
    expect(within(dialog).getByText("OpenSCENARIO file")).toBeTruthy();
    expect(within(dialog).getByText(/Environment and Traffic settings/i)).toBeTruthy();
    expect(within(dialog).getByText(/metric subject plus reasoning trace/i)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "simple" }));
    const mismatchedStart = within(dialog).getByRole("button", {
      name: "Start simple interactive tutorial",
    }) as HTMLButtonElement;
    expect(mismatchedStart.disabled).toBe(true);
    expect(mismatchedStart.title).toContain("Switch the editor to simple mode");
  });

  it("shows the focused route workflow in simple mode", () => {
    render(<EditorTutorialGuide experience="simple" />);
    openWrittenGuide();
    const dialog = screen.getByRole("dialog", { name: "Editor tutorial · Simple" });

    expect(within(dialog).getByText(/red unfinished route interaction/i)).toBeTruthy();
    expect(within(dialog).getByText(/Every route point represents one additional second/i)).toBeTruthy();
    expect(within(dialog).getByText(/actor stops at its last point/i)).toBeTruthy();
    expect(within(dialog).queryByText(/driver behavior/i)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Start simple interactive tutorial" })).toBeTruthy();
  });

  it("closes from the button, the backdrop or Escape and restores page scrolling", () => {
    render(<EditorTutorialGuide />);
    fireEvent.click(screen.getByRole("button", { name: "Tutorial" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "How would you like to learn?" })).toBeNull();
    expect(document.body.style.overflow).toBe("");

    openWrittenGuide();
    fireEvent.click(screen.getByRole("button", { name: "Close tutorial" }));
    expect(screen.queryByRole("dialog", { name: /Editor tutorial/ })).toBeNull();

    // The backdrop covers everything outside the guide, so a press that lands on it is a
    // press on the page behind the guide: it dismisses.
    openWrittenGuide();
    const backdrop = screen.getByTestId("editor-tutorial-backdrop");
    fireEvent.mouseDown(within(backdrop).getByRole("dialog"));
    expect(screen.queryByRole("dialog", { name: /Editor tutorial/ })).not.toBeNull();
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog", { name: /Editor tutorial/ })).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("asks for a format before launching the guided tutorial", () => {
    let selectedMode: unknown = null;
    const onStart = (event: Event) => {
      selectedMode = (event as CustomEvent).detail;
    };
    window.addEventListener("scenario:start-interactive-tutorial", onStart);
    render(<EditorTutorialGuide experience="simple" />);

    fireEvent.click(screen.getByRole("button", { name: "Tutorial" }));
    const chooser = screen.getByRole("dialog", { name: "How would you like to learn?" });
    expect(within(chooser).getByText("Guided tutorial")).toBeTruthy();
    expect(within(chooser).getByText("Written guide")).toBeTruthy();
    fireEvent.click(within(chooser).getByRole("button", { name: "Start guided tutorial" }));

    expect(selectedMode).toEqual({ mode: "simple" });
    expect(screen.queryByRole("dialog", { name: "How would you like to learn?" })).toBeNull();
    window.removeEventListener("scenario:start-interactive-tutorial", onStart);
  });
});
