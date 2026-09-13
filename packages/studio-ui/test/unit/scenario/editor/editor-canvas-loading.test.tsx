// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorCanvasRegion } from "../../../../src/scenario/editor/regions/EditorCanvasRegion";

const cityViewInstances = vi.hoisted(() => [] as Array<{
  complete: () => void;
  viewer: { readonly id: number };
}>);

vi.mock("@simforge-oss/viewer/react", async () => {
  const React = await import("react");
  return {
    CityView: ({
      manifestUrl,
      onMapLoaded,
      onReady,
    }: {
      manifestUrl: string;
      onMapLoaded?: (manifestUrl: string) => void;
      onReady?: (viewer: { readonly id: number }) => void;
    }) => {
      const viewer = React.useMemo(
        () => ({ id: cityViewInstances.length + 1 }),
        [],
      );
      React.useEffect(() => {
        onReady?.(viewer);
        cityViewInstances.push({
          complete: () => onMapLoaded?.(manifestUrl),
          viewer,
        });
      }, [manifestUrl, onMapLoaded, onReady, viewer]);
      return <canvas aria-label="Map canvas" />;
    },
  };
});

afterEach(() => {
  cleanup();
  cityViewInstances.length = 0;
});

describe("EditorCanvasRegion loading presentation", () => {
  it("shows map loading as a compact corner status instead of a canvas shade", () => {
    render(
      <EditorCanvasRegion
        hostRef={{ current: null }}
        map={{ label: "Test map", manifestUrl: "/manifest.json" } as never}
        quality="minimal"
        onViewerReady={vi.fn()}
        state={null}
        error={null}
      />,
    );

    const status = screen.getByTestId("scenario-map-status");
    expect(status.textContent).toContain("Loading map and lane topology");
    // A chip, not a cover: an inline status element that announces politely, carrying
    // nothing but its spinner and its label.
    expect(status.tagName).toBe("SPAN");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.querySelector("svg")).not.toBeNull();

    // The shade this replaced was a cloud surface drawn over the whole region. Neither it
    // nor its backdrop may come back, and the scene stays mounted and reachable beneath.
    const region = screen.getByTestId("scenario-editor-canvas-region");
    expect(region.contains(status)).toBe(true);
    expect(region.querySelector("[data-cloud-loading-scope]")).toBeNull();
    expect(screen.getByLabelText("Map canvas")).toBeTruthy();
  });

  it("ignores a stale map completion after quality remounts the viewer", () => {
    const onMapLoaded = vi.fn();
    const baseProps = {
      hostRef: { current: null },
      map: { label: "Test map", manifestUrl: "/manifest.json" } as never,
      onMapLoaded,
      onViewerReady: vi.fn(),
      state: null,
      error: null,
    };
    const view = render(
      <EditorCanvasRegion {...baseProps} quality="minimal" />,
    );
    expect(cityViewInstances).toHaveLength(1);

    view.rerender(<EditorCanvasRegion {...baseProps} quality="high" />);
    expect(cityViewInstances).toHaveLength(2);

    act(() => cityViewInstances[0]?.complete());
    expect(onMapLoaded).not.toHaveBeenCalled();

    act(() => cityViewInstances[1]?.complete());
    expect(onMapLoaded).toHaveBeenCalledOnce();
    expect(onMapLoaded).toHaveBeenCalledWith("/manifest.json");
  });
});
