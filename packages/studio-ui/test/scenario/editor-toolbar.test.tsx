// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorHeader } from "../../src/scenario/editor/regions/EditorHeader";
import {
  TopBarSlotProvider,
  useTopBarSlotContext,
} from "../../src/components/TopBarSlot";

afterEach(cleanup);

function TestTopBar() {
  const topBar = useTopBarSlotContext();
  return (
    <div data-testid="test-topbar">
      <span data-testid="test-topbar-title">{topBar?.customTitle}</span>
      <div
        ref={topBar?.registerActionsSlot}
        data-alignment={topBar?.actionsAlignment}
        data-testid="test-topbar-actions"
      />
      <div ref={topBar?.registerTrailingSlot} data-testid="test-topbar-trailing" />
    </div>
  );
}

function renderHeader(props: Partial<React.ComponentProps<typeof EditorHeader>> = {}) {
  return render(
    <TopBarSlotProvider>
      <TestTopBar />
      <EditorHeader
        onExit={() => undefined}
        {...props}
      />
    </TopBarSlotProvider>,
  );
}

describe("SimForge V1 editor toolbar", () => {
  it("shows only the editor actions at the start of the application top bar", () => {
    renderHeader();

    expect(screen.getByTestId("scenario-editor-toolbar").getAttribute("data-tour")).toBe("toolbar");
    expect(screen.getByTestId("test-topbar-title").textContent).toBe("Editor");
    expect(screen.getByTestId("test-topbar-actions").getAttribute("data-alignment")).toBe("start");
    expect(screen.queryByRole("button", { name: "Simulate in 2D" })).toBeNull();
    expect(screen.queryByRole("button", { name: /render/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /more/i })).toBeNull();
    const readinessButton = screen.getByRole("button", { name: "Scenario readiness: Ready" });
    expect(within(readinessButton).getByText("Ready")).toBeTruthy();
    expect(readinessButton.getAttribute("data-readiness-status")).toBe("ready");
    // Weather and traffic are no longer top-bar popovers; they are rail tools.
    expect(screen.queryByRole("button", { name: "Environment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Traffic" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add reasoning trace" }).getAttribute("title")).toBe(
      "Add a camera to a vehicle first",
    );
  });

  it("exits through the focused editor controls without exposing 2D submission", () => {
    const onExit = vi.fn();
    renderHeader({ onExit });

    fireEvent.click(screen.getByRole("button", { name: "Exit editor" }));
    expect(onExit).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("save-state")).toBeNull();
  });

  it("copies current support information from settings", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const getDebugInformation = vi.fn(() => "support-debug-payload");
    renderHeader({ getDebugInformation });

    expect(screen.queryByRole("button", { name: "Copy debug information" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy debug information" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("support-debug-payload"));
    expect(getDebugInformation).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Debug information copied" })).toBeTruthy();
  });

  it("pins simulation status before the reasoning trace and Settings at the far right", () => {
    renderHeader({
      simulationIssues: [
        {
          id: "route-warning",
          severity: "warning",
          title: "Route needs attention",
          detail: "One interaction could not be represented.",
        },
      ],
    });
    const toolbar = screen.getByTestId("scenario-editor-toolbar");
    const trailing = screen.getByTestId("scenario-editor-toolbar-trailing");
    const buttons = within(trailing).getAllByRole("button");

    expect(within(toolbar).queryByTestId("scenario-readiness-button")).toBeNull();
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Tutorial",
      "Scenario readiness: Simulation warnings, 1 item",
      "Add reasoning trace",
      "Settings",
    ]);
    const readinessButton = within(trailing).getByRole("button", {
      name: "Scenario readiness: Simulation warnings, 1 item",
    });
    expect(readinessButton.getAttribute("data-readiness-status")).toBe("needs-attention");
    expect(within(readinessButton).getByText("Simulation Warnings")).toBeTruthy();
    expect(within(readinessButton).getByTestId("scenario-readiness-count").textContent).toBe("1");
    fireEvent.click(readinessButton);
    expect(screen.getByTestId("scenario-readiness-drawer")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Export, 1 item" }));
    expect(screen.getByText("One interaction could not be represented.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(within(trailing).getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("viewport-settings-drawer")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Viewport and camera settings" })).toBeTruthy();
    expect(screen.getByText("Camera mode")).toBeTruthy();
  });

  it("places the reasoning trace action immediately before Settings and permits one row", () => {
    const setPresentationExtension = vi.fn();
    const document = {
      data: {
        roles: [{
          id: "camera-car",
          actor: { sensors: [{ type: "dash_camera" }] },
        }],
        metricSubject: null,
        reasoningTrace: [],
        extensions: {},
      },
      setPresentationExtension,
    };
    const { rerender } = renderHeader({ document: document as never });
    const trailing = screen.getByTestId("scenario-editor-toolbar-trailing");
    const labels = within(trailing).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(labels.indexOf("Add reasoning trace")).toBe(labels.indexOf("Settings") - 1);

    fireEvent.click(within(trailing).getByRole("button", { name: "Add reasoning trace" }));
    expect(setPresentationExtension).toHaveBeenCalledWith("studio.presentation.reasoningTraceLane", true);

    document.data.extensions = { "studio.presentation.reasoningTraceLane": true };
    rerender(
      <TopBarSlotProvider>
        <TestTopBar />
        <EditorHeader
          document={document as never}
          onExit={() => undefined}
        />
      </TopBarSlotProvider>,
    );
    expect(screen.getByRole("button", { name: "Add reasoning trace" }).hasAttribute("disabled")).toBe(true);
  });

  it("marks the scenario as needing attention when an error is present", () => {
    renderHeader({
      simulationIssues: [
        {
          id: "preview-error",
          severity: "error",
          title: "Preview failed",
          detail: "The scenario could not start.",
        },
      ],
    });

    const status = screen.getByTestId("scenario-readiness-button");
    expect(status.getAttribute("data-readiness-status")).toBe("needs-attention");
    expect(screen.getByTestId("scenario-readiness-count").textContent).toBe("1");
  });

  it("does not flag expected portability findings for an intentionally map-bound scenario", () => {
    renderHeader({
      document: {
        data: {
          roles: [{ id: "subject-car", kind: "scene_absolute", actor: { sensors: [] } }],
          metricSubject: null,
          reasoningTrace: [],
          extensions: {},
        },
        validation: {
          issues: [
            {
              severity: "warning",
              code: "non_portable_role",
              path: "roles.0",
              message: "This actor is placed in absolute scene coordinates.",
            },
            {
              severity: "warning",
              code: "pin_site_unresolved",
              path: "anchor.pin",
              message: "This scenario is pinned to a map but not a portable site.",
            },
          ],
        },
      } as never,
    });

    expect(screen.getByRole("button", { name: "Scenario readiness: Ready" })).toBeTruthy();
    expect(screen.queryByText(/absolute scene coordinates/i)).toBeNull();
  });

  it("shows a specific solution for an authoring warning", () => {
    renderHeader({
      document: {
        data: {
          roles: [],
          metricSubject: null,
          reasoningTrace: [],
          extensions: {},
        },
        validation: {
          issues: [
            {
              severity: "warning",
              code: "pin_site_unresolved",
              path: "anchor.pin",
              message: "This scenario is pinned to a map but not a portable site.",
            },
          ],
        },
      } as never,
    });

    fireEvent.click(screen.getByRole("button", {
      name: "Scenario readiness: Simulation warnings, 1 item",
    }));

    fireEvent.click(screen.getByRole("tab", { name: "Scenario behavior, 1 item" }));
    expect(screen.getByText("How to fix it")).toBeTruthy();
    expect(screen.getByText(/choose the exact road or junction/i)).toBeTruthy();
  });

  it("switches out of simple mode from settings", () => {
    const onExperienceToggle = vi.fn();
    renderHeader({ experience: "simple", onExperienceToggle });

    const trailing = screen.getByTestId("scenario-editor-toolbar-trailing");
    // Weather and traffic live in the left rail in both experiences; reasoning
    // traces stay advanced-only.
    expect(within(trailing).queryByRole("button", { name: "Environment" })).toBeNull();
    expect(within(trailing).queryByRole("button", { name: "Traffic" })).toBeNull();
    expect(within(trailing).queryByRole("button", { name: "Add reasoning trace" })).toBeNull();
    expect(within(trailing).queryByTestId("editor-experience-toggle")).toBeNull();

    fireEvent.click(within(trailing).getByRole("button", { name: "Settings" }));
    const modeToggle = screen.getByRole("switch", { name: "Simple mode" });
    expect(modeToggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(modeToggle);
    expect(onExperienceToggle).toHaveBeenCalledOnce();
  });

  it("reveals advanced authoring controls and offers simple mode in settings", () => {
    renderHeader({ experience: "advanced", onExperienceToggle: vi.fn() });

    const trailing = screen.getByTestId("scenario-editor-toolbar-trailing");
    expect(within(trailing).queryByRole("button", { name: "Environment" })).toBeNull();
    expect(within(trailing).queryByRole("button", { name: "Traffic" })).toBeNull();
    expect(within(trailing).getByRole("button", { name: "Add reasoning trace" })).toBeTruthy();

    fireEvent.click(within(trailing).getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("switch", { name: "Simple mode" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

});
