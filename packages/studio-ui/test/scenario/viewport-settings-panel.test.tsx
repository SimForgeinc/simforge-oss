// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CityViewer } from "@simforge-oss/viewer";
import { ViewportSettingsPanel } from "../../src/scenario/editor/regions/slots/ViewportSettingsPanel";
import { loadViewportSettings } from "../../src/scenario/editor/regions/slots/viewport-settings";

/**
 * The viewport settings panel.
 *
 * The defect this panel exists to fix: `viewer.setCameraControlPreferences` existed but no caller in the
 * app ever invoked it, so every session ran on frozen defaults and the invert flags and sensitivities were
 * unreachable. The load-bearing assertions here are therefore that the setter is called at all, that it is
 * called again when the viewer is replaced, and that a change reaches the live viewer without a confirm
 * step — a feel setting tuned behind an Apply button cannot be tuned.
 */

function fakeViewer() {
  return {
    setCameraControlPreferences: vi.fn(),
    setCameraMode: vi.fn(),
    setLayerVisible: vi.fn(),
  } as unknown as CityViewer & {
    setCameraControlPreferences: ReturnType<typeof vi.fn>;
    setCameraMode: ReturnType<typeof vi.fn>;
    setLayerVisible: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe("ViewportSettingsPanel", () => {
  it("starts collapsed so it does not cover the scene", () => {
    render(<ViewportSettingsPanel viewer={fakeViewer()} />);
    expect(screen.getByRole("button", { name: /Viewport and camera settings/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Viewport and camera settings/ })).toBeNull();
  });

  it("renders as a named top-bar settings action when requested", () => {
    render(<ViewportSettingsPanel viewer={fakeViewer()} placement="topbar" />);
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.textContent).toContain("Settings");
    fireEvent.click(settings);
    expect(screen.getByTestId("viewport-settings-drawer")).toBeTruthy();
    expect(screen.getByRole("group", { name: /Viewport and camera settings/ })).toBeTruthy();
  });

  it("changes render quality from the top-bar settings panel", () => {
    const onQualityChange = vi.fn();
    render(
      <ViewportSettingsPanel
        onQualityChange={onQualityChange}
        placement="topbar"
        quality="minimal"
        viewer={fakeViewer()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Render quality")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Balanced" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(onQualityChange).toHaveBeenCalledWith("high");
  });

  it("applies settings to the viewer on mount, even while collapsed", () => {
    // The whole point: the preferences have to reach the renderer whether or not anybody opens the panel.
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    expect(viewer.setCameraControlPreferences).toHaveBeenCalledTimes(1);
    expect(viewer.setCameraMode).toHaveBeenCalledWith("orbit");
    expect(viewer.setLayerVisible).toHaveBeenCalledWith("city", true);
    expect(viewer.setLayerVisible).toHaveBeenCalledWith("vegetation", true);
    expect(viewer.setLayerVisible).toHaveBeenCalledWith("road", true);
  });

  it("does nothing and does not throw when the viewer has not arrived yet", () => {
    expect(() => render(<ViewportSettingsPanel viewer={null} />)).not.toThrow();
  });

  it("re-applies to a replaced viewer instead of leaving it on defaults", () => {
    // The viewer is remounted whenever the quality preset changes. A one-shot apply would silently revert
    // every preference at that moment.
    const first = fakeViewer();
    const { rerender } = render(<ViewportSettingsPanel viewer={first} />);
    const second = fakeViewer();
    rerender(<ViewportSettingsPanel viewer={second} />);
    expect(second.setCameraControlPreferences).toHaveBeenCalledTimes(1);
  });

  it("pushes an invert toggle straight to the viewer, with no apply step", () => {
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    viewer.setCameraControlPreferences.mockClear();

    fireEvent.click(screen.getByRole("switch", { name: "Vertical look" }));
    expect(viewer.setCameraControlPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ reverseVerticalLook: true }),
    );
  });

  it("persists a change so the next session opens with it", () => {
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    fireEvent.click(screen.getByRole("switch", { name: "Horizontal pan" }));
    expect(loadViewportSettings().controls.reverseHorizontalPan).toBe(true);
  });

  it("switches camera mode and reports the bindings for the mode in force", () => {
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    expect(screen.getByText(/Drag orbits/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "fly" }));
    expect(viewer.setCameraMode).toHaveBeenCalledWith("fly");
    // The bindings differ per mode, so showing orbit's help under fly would be actively misleading.
    expect(screen.getByText(/Pointer-lock mouse look/)).toBeTruthy();
    expect(screen.queryByText(/Drag orbits/)).toBeNull();
  });

  it("hides a layer through the viewer's layer API", () => {
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    viewer.setLayerVisible.mockClear();

    fireEvent.click(screen.getByRole("switch", { name: "Vegetation" }));
    expect(viewer.setLayerVisible).toHaveBeenCalledWith("vegetation", false);
  });

  it("offers a reset only once something has moved, and it restores the defaults", () => {
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    // Nothing changed yet: a reset control here would be a button that does nothing.
    expect(screen.queryByRole("button", { name: /Reset all viewport settings/ })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Vertical look" }));
    const reset = screen.getByRole("button", { name: /Reset all viewport settings/ });
    fireEvent.click(reset);

    expect(loadViewportSettings().controls.reverseVerticalLook).toBe(false);
    expect(screen.queryByRole("button", { name: /Reset all viewport settings/ })).toBeNull();
  });

  it("moves a sensitivity slider within the range the renderer honours", () => {
    const viewer = fakeViewer();
    render(<ViewportSettingsPanel viewer={viewer} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));

    const slider = screen.getByLabelText("Wheel zoom") as HTMLInputElement;
    expect(slider.min).toBe("25");
    expect(slider.max).toBe("300");
    fireEvent.change(slider, { target: { value: "200" } });
    expect(viewer.setCameraControlPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ wheelZoomSensitivity: 200 }),
    );
  });

  it("gives look sensitivity the wider range pan does not get", () => {
    render(<ViewportSettingsPanel viewer={fakeViewer()} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    expect((screen.getByLabelText("Look X") as HTMLInputElement).max).toBe("750");
    expect((screen.getByLabelText("Look X") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("Look Y") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("Pan (middle)") as HTMLInputElement).max).toBe("300");
  });

  it("closes back to the button", () => {
    render(<ViewportSettingsPanel viewer={fakeViewer()} />);
    fireEvent.click(screen.getByRole("button", { name: /Viewport and camera settings/ }));
    fireEvent.click(screen.getByRole("button", { name: /Close viewport settings/ }));
    expect(screen.queryByRole("group", { name: /Viewport and camera settings/ })).toBeNull();
  });
});
