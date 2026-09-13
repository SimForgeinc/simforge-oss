// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorController, EditorState } from "@simforge-oss/editor";
import { EditorModeBanner } from "../../../../src/scenario/editor/regions/EditorModeBanner";

/**
 * `flash` is the controller answering something the author just did — a refused drag, a
 * cleared lane anchor. The strip is where that answer appears, and it has to appear in the
 * mode that provoked it: the modes that flash most (route drawing, grab) are exactly the
 * ones where a gesture that silently does nothing reads as a broken editor.
 */

afterEach(cleanup);

function banner(state: Partial<EditorState>) {
  render(
    <EditorModeBanner
      controller={null as unknown as EditorController}
      state={{ mode: "idle", hint: "", message: null, ...state } as EditorState}
    />,
  );
}

describe("EditorModeBanner", () => {
  it("shows a flash raised while a route is being drawn, over the standing hint", () => {
    banner({
      mode: "drawingRoute",
      hint: "5 route points · drag a 3D point to move",
      message: "The first point is the car's position — move the car to move it",
    });

    expect(screen.getByRole("status").textContent).toContain("The first point is the car's position");
    expect(screen.getByRole("status").textContent).not.toContain("5 route points");
  });

  it("falls back to the standing hint once the flash expires", () => {
    banner({ mode: "drawingRoute", hint: "5 route points · drag a 3D point to move", message: null });

    expect(screen.getByRole("status").textContent).toContain("5 route points");
  });

  it("shows a flash raised mid-grab, which no mode-specific branch used to reach", () => {
    banner({ mode: "grab", hint: "Move the selection", message: "lane anchor cleared" });

    expect(screen.getByRole("status").textContent).toContain("lane anchor cleared");
  });

  it("still renders nothing when idle with nothing to say", () => {
    banner({ mode: "idle", hint: "unused", message: null });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the warning treatment for a warning flash", () => {
    banner({ mode: "idle", hint: "", message: "Warning: no driving lane nearby" });

    expect(screen.getByRole("status").dataset.bannerVariant).toBe("warning");
  });

  it("uses the ordinary mode treatment for a non-warning flash", () => {
    banner({ mode: "grab", hint: "", message: "lane anchor cleared" });

    expect(screen.getByRole("status").dataset.bannerVariant).toBe("mode");
  });
});
