import { describe, expect, it } from "vitest";
import type { ScenarioDocumentDto, ScenarioSimulationPreviewDto, StudioHostServices } from "@simforge-oss/studio-host";
import { savedSimulationRevisionEvidence } from "./saved-simulation-evidence";

const document = { id: "uscn_1", draftVersion: 9 } as ScenarioDocumentDto;

/** A host whose only answer is the draft's saved-simulation descriptor; anything past it is a bug. */
function host(preview: ScenarioSimulationPreviewDto | null): StudioHostServices {
  return {
    projects: {
      getSimulationPreview: async () => preview,
    },
    artifacts: {
      listMaps: async () => { throw new Error("the map list must not be read before the saved simulation is admitted"); },
    },
  } as unknown as StudioHostServices;
}

describe("savedSimulationRevisionEvidence", () => {
  it("refuses a draft that was never simulated, naming the editor as the fix", async () => {
    await expect(savedSimulationRevisionEvidence(host(null), document)).rejects.toThrow(/no saved simulation yet.*Open it in the editor/);
  });

  it("refuses a saved simulation of an earlier draft version", async () => {
    const stale = { draftVersion: 8 } as ScenarioSimulationPreviewDto;
    await expect(savedSimulationRevisionEvidence(host(stale), document)).rejects.toThrow(/earlier version of this scenario/);
  });
});
