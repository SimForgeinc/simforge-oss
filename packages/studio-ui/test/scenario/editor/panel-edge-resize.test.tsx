/** @vitest-environment jsdom */

import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clampPanelWidth,
  loadPanelWidth,
  usePanelEdgeResize,
} from "../../../src/scenario/editor/usePanelEdgeResize";

/**
 * The resize behaviour shared by the editor's two docked popups.
 *
 * The cases worth holding: which drag direction grows which panel — a left-docked panel and a
 * right-docked one respond to opposite gestures, and getting that backwards is the defect a test
 * catches and a glance at the code does not — plus the clamp at both ends, the persisted width, and
 * keyboard reachability.
 */

const KEY = "test.panel-edge-width";

function Harness({
  edge,
  maxWidth = 200,
  minWidth = 100,
  defaultWidth = 150,
}: {
  edge: "left" | "right";
  maxWidth?: number;
  minWidth?: number;
  defaultWidth?: number;
}) {
  const { width, panelRef, separatorProps } = usePanelEdgeResize({
    storageKey: KEY,
    defaultWidth,
    minWidth,
    maxWidth,
    edge,
    label: "Resize the panel",
  });
  const localRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      data-testid="panel"
      data-width={width}
      ref={(node) => {
        localRef.current = node;
        (panelRef as { current: HTMLElement | null }).current = node;
      }}
      style={{ width }}
    >
      <div {...separatorProps} data-testid="handle" />
    </div>
  );
}

/** One complete drag gesture across the handle. */
function drag(handle: HTMLElement, byX: number) {
  fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
  fireEvent(handle, new PointerEvent("pointermove", { clientX: byX, bubbles: true }));
  fireEvent(handle, new PointerEvent("pointerup", { clientX: byX, bubbles: true }));
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no pointer capture; the drag installs its listeners on the handle regardless.
  Element.prototype.setPointerCapture = function setPointerCapture() {};
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
});

afterEach(cleanup);

describe("usePanelEdgeResize", () => {
  it("opens at the default width, a quarter under the ceiling", () => {
    render(<Harness edge="right" />);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("150");
  });

  it("grows a left-docked panel when its right edge is dragged right", () => {
    render(<Harness edge="right" />);
    drag(screen.getByTestId("handle"), 40);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("190");
  });

  it("grows a right-docked panel when its left edge is dragged left", () => {
    // Its own edge travels away from the dock, so the gesture is mirrored. Dragging right on this
    // panel must shrink it, not widen it off-screen.
    render(<Harness edge="left" />);
    drag(screen.getByTestId("handle"), -40);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("190");

    drag(screen.getByTestId("handle"), 30);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("160");
  });

  it("clamps at the ceiling and the floor", () => {
    render(<Harness edge="right" />);
    const handle = screen.getByTestId("handle");
    drag(handle, 5000);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("200");
    drag(handle, -5000);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("100");
  });

  it("remembers the width across a remount, and keeps it inside the bounds", () => {
    const view = render(<Harness edge="right" />);
    drag(screen.getByTestId("handle"), 30);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("180");

    view.unmount();
    render(<Harness edge="right" />);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("180");

    // A stored width from a wider build must not survive as an over-wide panel.
    window.localStorage.setItem(KEY, "9999");
    cleanup();
    render(<Harness edge="right" />);
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("200");
  });

  it("resizes from the keyboard, in the direction that matches the panel's edge", () => {
    render(<Harness edge="right" />);
    const handle = screen.getByTestId("handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("162");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("150");
    fireEvent.keyDown(handle, { key: "End" });
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("200");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("100");
  });

  it("mirrors the keyboard for a right-docked panel", () => {
    render(<Harness edge="left" />);
    const handle = screen.getByTestId("handle");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(screen.getByTestId("panel").getAttribute("data-width")).toBe("162");
  });

  it("announces the range it is driving", () => {
    render(<Harness edge="right" />);
    const handle = screen.getByTestId("handle");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuenow")).toBe("150");
    expect(handle.getAttribute("aria-valuemin")).toBe("100");
    expect(handle.getAttribute("aria-valuemax")).toBe("200");
    expect(handle.getAttribute("tabindex")).toBe("0");
  });
});

describe("width helpers", () => {
  it("clamps and rounds, and falls back to the ceiling for a nonsense width", () => {
    expect(clampPanelWidth(150.4, { minWidth: 100, maxWidth: 200 })).toBe(150);
    expect(clampPanelWidth(10, { minWidth: 100, maxWidth: 200 })).toBe(100);
    expect(clampPanelWidth(400, { minWidth: 100, maxWidth: 200 })).toBe(200);
    expect(clampPanelWidth(Number.NaN, { minWidth: 100, maxWidth: 200 })).toBe(200);
  });

  it("returns the default when nothing is stored", () => {
    window.localStorage.clear();
    expect(loadPanelWidth(KEY, { minWidth: 100, maxWidth: 200, defaultWidth: 150 })).toBe(150);
    window.localStorage.setItem(KEY, "not a number");
    expect(loadPanelWidth(KEY, { minWidth: 100, maxWidth: 200, defaultWidth: 150 })).toBe(150);
  });
});
