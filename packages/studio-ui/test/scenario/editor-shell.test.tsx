// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ScenarioEditorChromeHeader,
  ScenarioEditorShell,
  SCENARIO_EDITOR_SHELL_GEOMETRY,
  type ScenarioEditorShellSlotProps,
} from "../../src/scenario/editor/shell";

afterEach(cleanup);

function Shell(
  props: Partial<React.ComponentProps<typeof ScenarioEditorShell>> = {},
) {
  return (
    <ScenarioEditorShell
      header={<div>Header</div>}
      leftSidebar={<div>Scenario sidebar</div>}
      canvas={<canvas aria-label="Three scene" />}
      statusOverlay={<div>4 actors</div>}
      floatingOverlay={<div>Timeline transport</div>}
      {...props}
    />
  );
}

describe("ScenarioEditorShell", () => {
  it("publishes only the product shell regions", () => {
    render(<Shell />);

    const shell = screen.getByTestId("scenario-editor-shell");
    expect(shell.getAttribute("data-editor-shell-geometry")).toBe("v1");
    expect(shell.querySelector('[data-editor-shell-region="left-sidebar"]')).toBeTruthy();
    expect(shell.querySelector('[data-editor-shell-region="viewport"]')).toBeTruthy();
    expect(shell.querySelector('[data-editor-shell-region="status-overlay"]')).toBeTruthy();
    expect(shell.querySelector('[data-editor-shell-region="floating-overlay"]')).toBeTruthy();
    expect(shell.querySelector('[data-editor-shell-region="bottom"]')).toBeNull();
    expect(shell.querySelector('[data-editor-shell-region="inspector"]')).toBeNull();
  });

  it("hosts floating chrome over the viewport without taking canvas pointer ownership", () => {
    render(<Shell />);

    const floating = screen.getByText("Timeline transport").closest(
      '[data-editor-shell-region="floating-overlay"]',
    );
    expect(floating).not.toBeNull();
    expect(screen.getByLabelText("Three scene")).toBeTruthy();
  });

  it("removes the internal header row when controls are hosted by the application top bar", () => {
    render(<Shell header={null} />);

    const shell = screen.getByTestId("scenario-editor-shell");
    expect(shell.getAttribute("data-has-header")).toBe("false");
    expect(shell.querySelector('[data-editor-shell-region="header"]')).toBeNull();
    expect(screen.getByLabelText("Three scene")).toBeTruthy();
  });

  it("removes the permanent sidebar when tools own their expanding panels", () => {
    render(<Shell leftSidebar={null} />);

    const shell = screen.getByTestId("scenario-editor-shell");
    expect(shell.querySelector('[data-editor-shell-region="left-sidebar"]')).toBeNull();
    expect(screen.getByLabelText("Three scene")).toBeTruthy();
  });

  it("hands legacy selectors and geometry classes directly to render slots", () => {
    let canvasProps: ScenarioEditorShellSlotProps | null = null;
    render(
      <Shell
        canvas={(props) => {
          canvasProps = props;
          return <div {...props}>Canvas host</div>;
        }}
      />,
    );

    expect(canvasProps?.["data-testid"]).toBe("scenario-editor-canvas-region");
    expect(canvasProps?.["data-tutorial"]).toBe("canvas");
  });

  it("makes a transparent canvas slot pass through instead of intercepting the shared world", () => {
    render(<Shell canvasMode="passthrough" />);

    const shell = screen.getByTestId("scenario-editor-shell");
    const canvasRegion = screen.getByTestId("scenario-editor-canvas-region");
    expect(shell.getAttribute("data-canvas-mode")).toBe("passthrough");
    expect(shell.querySelector('[data-editor-shell-region="body"]')).toBeTruthy();
    expect(canvasRegion.getAttribute("data-editor-shell-region")).toBe("canvas");
  });

  it("updates the sidebar without replacing the canvas slot", () => {
    const { rerender } = render(<Shell leftSidebar={<div>Scenario list</div>} />);
    const canvas = screen.getByLabelText("Three scene");
    expect(screen.getByText("Scenario list")).toBeTruthy();

    rerender(<Shell leftSidebar={<div>Timeline</div>} />);
    expect(screen.getByText("Timeline")).toBeTruthy();
    expect(screen.getByLabelText("Three scene")).toBe(canvas);
  });

  it("keeps the sidebar before the viewport for stacking without replacing the canvas", () => {
    render(<Shell leftSidebar={<div>Tool rail</div>} />);

    const shell = screen.getByTestId("scenario-editor-shell");
    const body = shell.querySelector('[data-editor-shell-region="body"]');
    const sidebar = shell.querySelector('[data-editor-shell-region="left-sidebar"]');
    const viewport = shell.querySelector('[data-editor-shell-region="viewport"]');
    expect(body?.firstElementChild).toBe(sidebar);
    expect(sidebar?.nextElementSibling).toBe(viewport);
  });

  it("can explicitly disable chrome without unmounting the canvas", () => {
    const { rerender } = render(<Shell />);
    const canvas = screen.getByLabelText("Three scene");

    rerender(<Shell disabled />);

    const shell = screen.getByTestId("scenario-editor-shell");
    expect(shell.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("scenario-editor-canvas-region").hasAttribute("inert")).toBe(true);
    expect(screen.getByLabelText("Three scene")).toBe(canvas);
  });

  it("accepts geometry overrides without changing the shared defaults", () => {
    render(
      <Shell
        geometryStyle={{ "--scenario-left-sidebar-width": "15rem" }}
      />,
    );

    const shell = screen.getByTestId("scenario-editor-shell");
    expect(shell.style.getPropertyValue("--scenario-left-sidebar-width")).toBe("15rem");
    expect(SCENARIO_EDITOR_SHELL_GEOMETRY.leftSidebarWidth).toBe("31.25rem");
  });
});

describe("ScenarioEditorChromeHeader", () => {
  it("renders compact document identity, state and action slots", () => {
    render(
      <ScenarioEditorChromeHeader
        title="Crosswalk encounter"
        subtitle="Town 10 · OpenSCENARIO 1.4"
        status="Saved"
        statusTone="saved"
        actions={<button type="button">Render</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Crosswalk encounter" })).toBeTruthy();
    expect(screen.getByText("Town 10 · OpenSCENARIO 1.4")).toBeTruthy();
    expect(screen.getByText("Saved").getAttribute("data-editor-header-status")).toBe("saved");
    expect(screen.getByRole("button", { name: "Render" })).toBeTruthy();
  });
});
