import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDocumentDto, ScenarioSimulationPreviewDto, StudioHostServices } from "@simforge-oss/studio-host";

const prepare = vi.fn();
const dispose = vi.fn();
const bundle = { ambientTraffic: { actors: [] }, trace: {} };

vi.mock("../playback/scenarioWorkerClient", () => ({
  ScenarioWorkerClient: class {
    prepare = prepare;
    dispose = dispose;
  },
}));
vi.mock("../playback/simulationPreview", () => ({
  downloadSimulationPreview: vi.fn(async () => bundle),
}));
vi.mock("../maps", () => ({ playbackMapEntry: vi.fn((map) => map) }));
vi.mock("./materialized-traffic", () => ({
  uploadAndConsumeMaterializedTraffic: vi.fn(async () => ({ reference: { artifactId: "artifact" } })),
}));
vi.mock("@simforge-oss/playback/traffic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simforge-oss/playback/traffic")>()),
  browserRevisionTraffic: vi.fn(() => ({
    artifact: { artifact: { provider: { id: "disabled" }, sourceInputDigest: "digest" } },
    sha256: "sha",
  })),
  ambientProvenanceForRevisionTraffic: vi.fn(() => ({})),
}));

import { savedSimulationRevisionEvidence } from "./saved-simulation-evidence";

const document = {
  id: "uscn_1",
  draftVersion: 9,
  mapVersionId: "map_1",
  content: { extensions: {}, mapSignalPlans: [] },
} as unknown as ScenarioDocumentDto;
const map = {
  id: "map_1",
  versionId: "map_1",
  mapVersionId: "map_1",
  sourceMapId: "source_1",
  label: "Test map",
  locality: "",
  browserAssetRootUrl: "https://example.test/assets",
  browserManifestUrl: "https://example.test/assets/3d/manifest.json",
  browserClosureSha256: "closure",
  artifacts: {},
  sumoNetworkSha256: null,
} as never;

function host(preview: ScenarioSimulationPreviewDto | null): StudioHostServices {
  return {
    projects: {
      getSimulationPreview: async () => preview,
      uploadMaterializedTraffic: async () => ({ artifactId: "artifact", sha256: "sha", sizeBytes: 1 }),
    },
    artifacts: {
      listMaps: async () => [map],
    },
  } as unknown as StudioHostServices;
}

describe("savedSimulationRevisionEvidence", () => {
  beforeEach(() => {
    prepare.mockResolvedValue(bundle);
    prepare.mockClear();
    dispose.mockClear();
  });

  it("reuses a valid preview for the same draft without starting a worker", async () => {
    await savedSimulationRevisionEvidence(host({ draftVersion: 9 } as ScenarioSimulationPreviewDto), document);
    expect(prepare).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["stale", { draftVersion: 8 } as ScenarioSimulationPreviewDto],
  ])("prepares the current document when the preview is %s", async (_label, preview) => {
    await savedSimulationRevisionEvidence(host(preview), document);
    expect(prepare).toHaveBeenCalledWith(
      document.content,
      expect.anything(),
      expect.anything(),
      undefined,
      { backgroundPreview: true },
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
