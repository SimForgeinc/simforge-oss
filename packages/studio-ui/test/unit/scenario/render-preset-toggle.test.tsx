// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDashCamera, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import type { StudioHostCapabilities, StudioHostServices } from "@simforge-oss/studio-host";
import { StudioHostProvider } from "../../../src/host";
import { RenderConfigPanel } from "../../../src/scenario/editor/render/RenderConfigPanel";

afterEach(cleanup);

/** One car with one dash camera: the smallest scenario the render wizard can submit. */
function content(): ScenarioTemplateV2 {
  const camera = { ...defaultDashCamera({ class: "car" }), id: "front-camera" };
  return {
    scenarioVersion: 2,
    meta: { name: "Render", description: "", createdAt: "2026-09-24T00:00:00.000Z", modifiedAt: "2026-09-24T00:00:00.000Z", appVersion: "test", tags: [], negativeControl: false },
    params: { declarations: [], constraints: [] },
    environment: { weather: "clear", timeOfDay: "noon", surfacePatches: [] },
    anchor: { id: "anchor", corridor: {}, features: [], policy: {} },
    roles: [{ id: "ego", label: "Ego", actor: { class: "car", sensors: [camera] } }],
    props: [],
    trafficControls: [],
    mapSignalPlans: [],
    choreography: { warmupSeconds: 0, clipSeconds: 10, interactions: [] },
    perception: {},
    invariants: [],
    variants: [],
    reasoningTrace: [],
  } as unknown as ScenarioTemplateV2;
}

/** A cloud host that accepts native renders, with an exported revision whose original simulation is stored. */
function host(submitRenderIntent: ReturnType<typeof vi.fn>): StudioHostServices {
  const capabilities = {
    host: { kind: "cloud", label: "SimCloud", version: null },
    identity: { mode: "account", userId: "u", workspaceId: "w", organizationId: null, displayName: null, workspaceName: null },
    persistence: { kind: "managed-postgres-object-storage" },
    execution: {
      browserSimulation: true,
      renderWorkers: { native: { available: true, reason: null } },
      workerNodes: [],
      nativeRuntime: { state: "unavailable", code: "not_offered", reason: "cloud", searchedPaths: [] },
    },
    jobs: { families: ["openscenario_compile", "openscenario_render"], survivesUiClose: true },
  } as unknown as StudioHostCapabilities;
  return {
    runtime: { capabilities: async () => capabilities },
    jobs: {
      listExports: async () => [{ id: "usexp_1", status: "succeeded", executionPackageId: "usepkg_1", startedAt: "2026-09-24T00:00:00.000Z" }],
      submitRenderIntent,
    },
    projects: {
      getRevisionMotion: async () => ({
        currentEngineSemVer: "1.0.0",
        legacyXoscAvailable: false,
        active: { engineSemVer: "1.0.0", original: true, simKey: "a".repeat(64), reason: "commit" },
      }),
    },
  } as unknown as StudioHostServices;
}

async function walkUntil(testId: string) {
  for (let step = 0; step < 8 && !screen.queryByTestId(testId); step += 1) {
    const next = await screen.findByTestId("render-wizard-next");
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(next);
  }
  return screen.findByTestId(testId);
}

describe("render preset toggle (native)", () => {
  it("offers Training (fast) and Showcase (quality), defaults to Showcase, and submits the choice", async () => {
    const submitRenderIntent = vi.fn(async () => ({ id: "usrj_1" }));
    render(
      <StudioHostProvider host={host(submitRenderIntent)}>
        <RenderConfigPanel
          ensureSnapshot={async () => "usrev_1"}
          currentContent={content()}
          onClose={() => undefined}
          onManagedJobCreated={() => undefined}
          onEsminiRunCreated={() => undefined}
        />
      </StudioHostProvider>,
    );

    const native = await screen.findByTestId("render-backend-native");
    await waitFor(() => expect((native as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(native);
    fireEvent.click(await screen.findByTestId("render-wizard-next"));
    // Native's cameras step starts with every authored camera on RGB.
    await screen.findByTestId("render-sensor-front-camera");

    const group = await walkUntil("render-preset");
    expect(group.getAttribute("role")).toBe("radiogroup");
    const training = screen.getByTestId("render-preset-training");
    const showcase = screen.getByTestId("render-preset-showcase");
    expect(training.textContent).toContain("Training (fast)");
    expect(showcase.textContent).toContain("Showcase (quality)");
    expect(showcase.getAttribute("aria-checked")).toBe("true");
    expect(training.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(training);
    expect(training.getAttribute("aria-checked")).toBe("true");
    expect(showcase.getAttribute("aria-checked")).toBe("false");

    const run = await walkUntil("render-run-button");
    expect(screen.getByText("Training (fast)")).not.toBeNull();
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(submitRenderIntent).toHaveBeenCalledTimes(1));
    expect(submitRenderIntent.mock.calls[0]![0]).toMatchObject({ engine: "native", render: { preset: "training" } });
  });

  it("submits Showcase when the author does not choose", async () => {
    const submitRenderIntent = vi.fn(async () => ({ id: "usrj_2" }));
    render(
      <StudioHostProvider host={host(submitRenderIntent)}>
        <RenderConfigPanel
          ensureSnapshot={async () => "usrev_1"}
          currentContent={content()}
          onClose={() => undefined}
          onManagedJobCreated={() => undefined}
          onEsminiRunCreated={() => undefined}
        />
      </StudioHostProvider>,
    );
    const native = await screen.findByTestId("render-backend-native");
    await waitFor(() => expect((native as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(native);
    fireEvent.click(await screen.findByTestId("render-wizard-next"));
    // Native's cameras step starts with every authored camera on RGB.
    await screen.findByTestId("render-sensor-front-camera");
    const run = await walkUntil("render-run-button");
    expect(screen.getByText("Showcase (quality)")).not.toBeNull();
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    await waitFor(() => expect(submitRenderIntent).toHaveBeenCalledTimes(1));
    expect(submitRenderIntent.mock.calls[0]![0]).toMatchObject({ render: { preset: "showcase" } });
  });
});
