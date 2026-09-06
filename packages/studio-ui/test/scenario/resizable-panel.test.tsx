// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  ResizablePanel,
  loadPanelWidth,
} from "../../src/scenario/ResizablePanel";

/**
 * The resizable list panel.
 *
 * The list starts 25% narrower than its original 500px presentation while retaining enough room for
 * scenario metadata. The cases worth holding: the width clamps at both ends, it survives a reload, and it
 * is reachable without a pointer — a `role="separator"` that takes focus and ignores the keyboard is worse
 * than one that is not focusable at all.
 */

const KEY = "test.panel-width";

function renderPanel() {
  return render(
    <ResizablePanel storageKey={KEY} label="Resize the list">
      <p>list contents</p>
    </ResizablePanel>,
  );
}

function handle() {
  return screen.getByRole("separator", { name: "Resize the list" });
}

function panelWidth(): number {
  const panel = screen.getByTestId("scenario-resizable-panel");
  return Number.parseInt(panel.style.width, 10);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe("ResizablePanel", () => {
  it("uses the compact default width when nothing is stored", () => {
    renderPanel();
    expect(DEFAULT_PANEL_WIDTH).toBe(375);
    expect(panelWidth()).toBe(375);
  });

  it("renders its children", () => {
    renderPanel();
    expect(screen.getByText("list contents")).toBeTruthy();
  });

  it("exposes the current width on the separator for assistive tech", () => {
    renderPanel();
    expect(handle().getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH));
    expect(handle().getAttribute("aria-valuemin")).toBe(String(MIN_PANEL_WIDTH));
    expect(handle().getAttribute("aria-valuemax")).toBe(String(MAX_PANEL_WIDTH));
  });

  it("widens and narrows with the arrow keys", () => {
    renderPanel();
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(panelWidth()).toBe(DEFAULT_PANEL_WIDTH + 10);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(panelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("takes a coarser step with shift held", () => {
    renderPanel();
    fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(panelWidth()).toBe(DEFAULT_PANEL_WIDTH + 50);
  });

  it("jumps to each bound with Home and End", () => {
    renderPanel();
    fireEvent.keyDown(handle(), { key: "End" });
    expect(panelWidth()).toBe(MAX_PANEL_WIDTH);
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(panelWidth()).toBe(MIN_PANEL_WIDTH);
  });

  it("clamps at both bounds rather than running past them", () => {
    renderPanel();
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(panelWidth()).toBe(MAX_PANEL_WIDTH);
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle(), { key: "ArrowLeft", shiftKey: true });
    expect(panelWidth()).toBe(MIN_PANEL_WIDTH);
  });

  it("ignores keys that are not a resize", () => {
    renderPanel();
    fireEvent.keyDown(handle(), { key: "a" });
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(panelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("persists the width and restores it on the next mount", () => {
    const first = renderPanel();
    fireEvent.keyDown(handle(), { key: "End" });
    expect(loadPanelWidth(KEY)).toBe(MAX_PANEL_WIDTH);
    first.unmount();

    renderPanel();
    expect(panelWidth()).toBe(MAX_PANEL_WIDTH);
  });

  it("keeps two panels' widths apart, so one does not resize the other", () => {
    render(
      <>
        <ResizablePanel storageKey="test.panel-a" label="Resize A">
          <p>a</p>
        </ResizablePanel>
        <ResizablePanel storageKey="test.panel-b" label="Resize B">
          <p>b</p>
        </ResizablePanel>
      </>,
    );
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize A" }), { key: "End" });
    expect(loadPanelWidth("test.panel-a")).toBe(MAX_PANEL_WIDTH);
    expect(loadPanelWidth("test.panel-b")).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe("loadPanelWidth", () => {
  it("returns the default when nothing is stored", () => {
    expect(loadPanelWidth(KEY)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("clamps a stored width that is now out of bounds instead of discarding it", () => {
    // The bounds may have narrowed since the value was written. The nearest legal width is closer to the
    // stored intent than the default is.
    window.localStorage.setItem(KEY, "5000");
    expect(loadPanelWidth(KEY)).toBe(MAX_PANEL_WIDTH);
    window.localStorage.setItem(KEY, "10");
    expect(loadPanelWidth(KEY)).toBe(MIN_PANEL_WIDTH);
  });

  it("falls back to the default for a non-numeric stored value", () => {
    window.localStorage.setItem(KEY, "wide");
    expect(loadPanelWidth(KEY)).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe("collapsing for a full-width neighbour", () => {
  /**
   * The render pane asks for the whole width when it opens one render. The list yields it by sliding
   * out, so returning restores the same panel — and the same scroll position — rather than remounting
   * a list that would have to refetch.
   */
  it("slides out under its own width, keeping the children's layout intact", () => {
    render(
      <ResizablePanel collapsed storageKey={KEY} label="Resize the list">
        <p>list contents</p>
      </ResizablePanel>,
    );
    const panel = screen.getByTestId("scenario-resizable-panel");

    expect(panel.getAttribute("data-panel-collapsed")).toBe("true");
    // Negative margin, not `width: 0`: the children keep their measured width and travel as a block.
    expect(panel.style.marginLeft).toBe(`-${DEFAULT_PANEL_WIDTH}px`);
    expect(panel.style.width).toBe(`${DEFAULT_PANEL_WIDTH}px`);
    expect(screen.getByText("list contents")).not.toBeNull();
  });

  it("is inert while collapsed, so focus cannot land on an off-screen row", () => {
    render(
      <ResizablePanel collapsed storageKey={KEY} label="Resize the list">
        <button type="button">open scenario</button>
      </ResizablePanel>,
    );
    const panel = screen.getByTestId("scenario-resizable-panel");
    expect(panel.hasAttribute("inert")).toBe(true);
  });

  it("occupies its width and takes input when not collapsed", () => {
    renderPanel();
    const panel = screen.getByTestId("scenario-resizable-panel");
    expect(panel.getAttribute("data-panel-collapsed")).toBeNull();
    expect(panel.style.marginLeft).toBe("0px");
    expect(panel.hasAttribute("inert")).toBe(false);
  });
});
