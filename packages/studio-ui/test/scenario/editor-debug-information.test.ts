// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildEditorDebugInformation } from "../../src/scenario/editor/debug-information";

describe("editor support debug information", () => {
  it("includes live scenario and actor details without copying workspace or asset URLs", () => {
    window.history.replaceState({}, "", "/dashboard/scenario?dataset=dataset-query&document=scenario-query");
    const text = buildEditorDebugInformation({
      datasetId: "dataset-1",
      record: {
        id: "scenario-1",
        workspaceId: "workspace-private",
        title: "Intersection test",
        draftVersion: 7,
        schemaVersion: "2",
        content: { meta: { name: "saved configuration" } },
        mapVersionId: "map-version-1",
        datasetId: "dataset-1",
        authoringQualityId: "minimal",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        latestRevisionId: "revision-1",
      } as never,
      map: {
        versionId: "map-version-1",
        sourceMapId: "source-map-1",
        label: "Support map",
        locality: "Test city",
        coordinateSystemId: "local",
        browserManifestUrl: "https://signed.example/secret",
      } as never,
      quality: "minimal",
      scenarioConfiguration: { meta: { name: "live configuration" } } as never,
      selectedActor: { id: "actor-1", catalogId: "vehicle.ambulance" } as never,
      state: {
        mode: "idle",
        selection: ["actor-1"],
        dirty: true,
        savedAt: null,
        placementWarning: null,
        message: null,
        laneLabel: "12:0:-1",
        actors: [{ id: "actor-1" }],
      } as never,
      simulationIssues: [],
      documentRevision: 12,
      saveError: null,
      validation: { ok: true },
      preview: {
        instance: {
          input: {
            actors: [{
              id: "actor-1",
              kind: "pedestrian",
              initial: { speedMps: 1 },
              behavior: {
                route: {
                  kind: "polyline",
                  points: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
                },
              },
            }],
          },
        },
        trace: {
          header: {
            inputHash: "input-hash",
            engineVersion: "test-engine",
            traceVersion: 4,
            dt: 1,
            clipSeconds: 3,
            actorMetadata: { "actor-1": { kind: "pedestrian" } },
            physics: { crashes: { "actor-1": { t: 2, otherId: "map:wall-1", reason: "material-collision" } } },
          },
          ticks: {
            t: [0, 1, 2, 3],
            actors: {
              "actor-1": {
                x: [0, 1, 2, 2],
                z: [0, 0, 0, 0],
                s: [0, 1, 2, 2],
                speedMps: [1, 1, 0, 0],
                present: [1, 1, 1, 1],
              },
            },
          },
          events: [
            { t: 2, kind: "collision", a: "actor-1", b: "map:wall-1" },
            { t: 2, kind: "crash_disabled", actorId: "actor-1", otherId: "map:wall-1", reason: "material-collision" },
          ],
        },
        mapCollisions: { status: "ready", digest: "collider-digest", accepted: 1, rejectedRoadOverlap: 0, classes: { wall: 1 } },
      } as never,
    });
    const payload = JSON.parse(text);

    expect(payload.format).toBe("simforge.uniscenario.support-debug.v1");
    expect(payload.identifiers).toMatchObject({
      datasetId: "dataset-1",
      scenarioId: "scenario-1",
      selectedActorId: "actor-1",
      mapVersionId: "map-version-1",
    });
    expect(payload.scenario.configuration.meta.name).toBe("live configuration");
    expect(payload.selectedActor.catalogId).toBe("vehicle.ambulance");
    expect(payload.browser.query).toEqual({ dataset: "dataset-query", document: "scenario-query" });
    expect(payload.preview).toMatchObject({
      complete: true,
      mapCollisions: { status: "ready" },
      actors: [{
        actorId: "actor-1",
        configuredInitialSpeedKph: 3.6,
        resolvedRouteLengthM: 10,
        distanceTraveledM: 2,
        finalDisplacementM: 2,
        stoppedAtS: 2,
        crash: { otherId: "map:wall-1" },
      }],
    });
    expect(payload.preview.actors[0].samples).toHaveLength(4);
    expect(payload.preview.actors[0].events).toHaveLength(2);
    expect(text).not.toContain("workspace-private");
    expect(text).not.toContain("https://signed.example/secret");
  });
});
