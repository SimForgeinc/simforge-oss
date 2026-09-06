// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlacementCursorHint } from "../../../../src/scenario/editor/regions/PlacementCursorHint";

afterEach(cleanup);

describe("PlacementCursorHint", () => {
  it("stays silent outside placement and follows the map pointer while placing", () => {
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    const hostRef = { current: document.createElement("div") };
    const placing = {
      mode: "placing",
      valid: true,
      snapped: true,
      laneLabel: "Lane 12 · eastbound",
    };
    const { rerender } = render(
      <PlacementCursorHint state={{ ...placing, mode: "idle" } as never} hostRef={hostRef} canvas={canvas} />,
    );
    expect(screen.queryByTestId("placement-cursor-hint")).toBeNull();

    rerender(<PlacementCursorHint state={placing as never} hostRef={hostRef} canvas={canvas} />);
    const hint = screen.getByTestId("placement-cursor-hint");
    expect(hint.getAttribute("data-placement-valid")).toBe("true");
    expect(hint.textContent).toContain("Click to place");
    expect(hint.textContent).toContain("Lane 12 · eastbound");

    fireEvent.pointerMove(canvas, { clientX: 120, clientY: 180 });
    expect(hint.style.left).toBe("136px");
    expect(hint.style.top).toBe("198px");
    canvas.remove();
  });

  it("shows restrained invalid-placement guidance", () => {
    render(
      <PlacementCursorHint
        state={{ mode: "placing", valid: false, snapped: false, laneLabel: null } as never}
        hostRef={{ current: null }}
      />,
    );
    const hint = screen.getByTestId("placement-cursor-hint");
    expect(hint.getAttribute("data-placement-valid")).toBe("false");
    expect(hint.textContent).toContain("Move onto a valid surface");
    expect(hint.className).toContain("pointer-events-none");
  });

  it("shows a non-blocking route warning for a risky lane", () => {
    render(
      <PlacementCursorHint
        state={{
          mode: "placing",
          valid: true,
          snapped: true,
          laneLabel: "Lane 8",
          placementWarning: "Warning: this position commits the actor to a right turn.",
        } as never}
        hostRef={{ current: null }}
      />,
    );
    const hint = screen.getByTestId("placement-cursor-hint");
    expect(hint.getAttribute("data-placement-valid")).toBe("true");
    expect(hint.getAttribute("data-placement-warning")).toBe("true");
    expect(hint.textContent).toContain("click to place anyway");
    expect(hint.textContent).toContain("right turn");
    expect(hint.textContent).toContain("Interactions may not work properly on this road.");
    expect(hint.className).toContain("border-amber-300/80");
    expect(hint.className).toContain("bg-amber-400/25");
    expect(hint.className).toContain("text-amber-50");
  });

  it("reuses the placement warning presentation while moving an actor", () => {
    const warning = "Warning: this position commits the actor to a right turn.";
    const hostRef = { current: null };
    const { rerender } = render(
      <PlacementCursorHint
        state={{
          mode: "placing",
          valid: true,
          snapped: true,
          laneLabel: "Lane 8",
          placementWarning: warning,
        } as never}
        hostRef={hostRef}
      />,
    );
    const addHint = screen.getByTestId("placement-cursor-hint");
    const addWarningClasses = addHint.className;

    rerender(
      <PlacementCursorHint
        state={{
          mode: "grab",
          valid: true,
          snapped: true,
          laneLabel: "Lane 8",
          placementWarning: warning,
          dropOutcome: "snapped",
        } as never}
        hostRef={hostRef}
      />,
    );
    const moveHint = screen.getByTestId("placement-cursor-hint");
    expect(moveHint.getAttribute("data-placement-mode")).toBe("grab");
    expect(moveHint.getAttribute("data-placement-warning")).toBe("true");
    expect(moveHint.className).toBe(addWarningClasses);
    expect(moveHint.textContent).toContain(warning);
    expect(moveHint.textContent).toContain("click to move anyway");
    expect(moveHint.textContent).toContain("Interactions may not work properly on this road.");
  });

  it("warns that an off-road move will leave the actor unanchored", () => {
    render(
      <PlacementCursorHint
        state={{
          mode: "grab",
          valid: true,
          snapped: false,
          placementWarning: null,
          dropOutcome: "free",
        } as never}
        hostRef={{ current: null }}
      />,
    );
    const hint = screen.getByTestId("placement-cursor-hint");
    expect(hint.getAttribute("data-placement-warning")).toBe("true");
    expect(hint.textContent).toContain("off-road — will place unanchored");
    expect(hint.className).toContain("border-amber-300/80");
  });
});
