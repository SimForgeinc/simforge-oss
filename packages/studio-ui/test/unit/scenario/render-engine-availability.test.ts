import { describe, expect, it } from "vitest";
import type { StudioHostCapabilities } from "@simforge-oss/studio-host";
import { engineAvailability } from "../../../src/scenario/editor/render/RenderConfigPanel";

function capabilities(families: StudioHostCapabilities["jobs"]["families"]): StudioHostCapabilities {
  return {
    host: { kind: "cloud", label: "SimCloud", version: null },
    persistence: { kind: "managed-postgres-object-storage" },
    execution: {
      browserSimulation: true,
      renderWorkers: {},
      workerNodes: [],
      nativeRuntime: { state: "unavailable", code: "not_offered", reason: "cloud", searchedPaths: [] },
    },
    jobs: { families, survivesUiClose: true },
  } as unknown as StudioHostCapabilities;
}

describe("esmini engine card", () => {
  it("is offered only by a host that lists the openscenario_validate job family", () => {
    expect(engineAvailability("esmini", capabilities(["openscenario_compile", "openscenario_validate"])).offered).toBe(true);
    const withoutLane = engineAvailability("esmini", capabilities(["openscenario_compile", "openscenario_render"]));
    expect(withoutLane.offered).toBe(false);
    expect(withoutLane.reason).toBe("SimCloud does not run esmini validation.");
  });

  it("is not a choice until the host has answered", () => {
    expect(engineAvailability("esmini", null).offered).toBe(false);
  });
});
