import { describe, expect, it } from "vitest";
import type { ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { contentHash, parseSimScenarioInput } from "@simforge-oss/engine";
import { parsePlaybackPair } from "@simforge-oss/playback";
import { withStudioBodyColorTags } from "@simforge-oss/compiler";

/**
 * The regression this fixes, proven through the real decoder rather than
 * through the tag string alone.
 *
 * The browser sim engine never reads the editor document: `parsePlaybackPair`
 * rebuilds actors from the concrete instance, and `PlaybackActor.bodyColor` is
 * derived exclusively from a `studio:body-color:` SimActor tag. The materializer
 * projects other role extensions onto tags but never this one, so before the fix
 * every played car arrived with no `bodyColor` and the renderer used its default
 * tint — the editor looked right because the authoring scene tints from the
 * document extension directly.
 *
 * `samplePlaybackActors` is the exact call the renderer and the browser sensor
 * capture make to obtain per-frame `ActorView`s, so asserting the tint there
 * covers what the author actually sees while the scenario plays.
 */

const MAP_ID = "town10";
const GRAPH_DIGEST = "b".repeat(64);
const PAINT = "#8c2f2f";

function playedActors(bodyColor: unknown, { decorate = true } = {}) {
  const template = {
    roles: [{ id: "hero", extensions: { "studio.presentation.bodyColor": bodyColor } }],
  } as unknown as ScenarioTemplateV2;

  const materialized = parseSimScenarioInput({
    mapId: MAP_ID,
    clipSeconds: 1,
    warmupSeconds: 0,
    dt: 0.2,
    seed: `studio-body-color:${MAP_ID}`,
    actors: [
      {
        id: "hero-actor",
        kind: "vehicle",
        static: false,
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
        behavior: { route: { kind: "polyline", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
        // Exactly what the materializer emits for a map-bound authored role.
        tags: ["role:hero", "class:vehicle", "binding:scene_absolute", "catalog:vehicle.sedan"],
      },
    ],
    physics: { mode: "dynamic-v1" },
  });

  const input = decorate ? withStudioBodyColorTags(materialized, template) : materialized;
  const inputHash = contentHash(input);
  const times = [0, 0.2, 0.4, 0.6, 0.8, 1];

  const instance = {
    kind: "scenario-instance",
    version: 1,
    manifest: {
      instanceId: "studio-body-color-fixture",
      inputHash,
      replayKey: { mapId: MAP_ID, engineGraphDigest: GRAPH_DIGEST },
      actors: input.actors.map((actor) => ({ id: actor.id })),
    },
    input,
  };

  const trace = {
    header: {
      traceVersion: 4,
      frame: "xodr-local",
      inputHash,
      mapId: MAP_ID,
      engineGraphDigest: GRAPH_DIGEST,
      topologyDigest: GRAPH_DIGEST,
      clipSeconds: input.clipSeconds,
      warmupSeconds: input.warmupSeconds,
      dt: input.dt,
      operationalConditions: input.operationalConditions,
      actorIds: input.actors.map((actor) => actor.id),
    },
    ticks: {
      t: times,
      actors: Object.fromEntries(
        input.actors.map((actor) => [
          actor.id,
          {
            x: times.map(() => 0),
            y: times.map(() => 0),
            headingRad: times.map(() => 0),
            speedMps: times.map(() => 0),
            laneRsl: times.map(() => ""),
            s: times.map(() => 0),
            lateralOffsetM: times.map(() => 0),
            present: times.map(() => 1),
          },
        ]),
      ),
    },
    events: [],
  };

  return parsePlaybackPair(instance, trace, {
    instanceName: "studio body color instance",
    traceName: "studio body color trace",
  });
}

describe("authored paint reaches browser playback", () => {
  it("paints the played car the colour the author chose", () => {
    // `PlaybackActor.bodyColor` is what the playback presenter reads per frame
    // (`metadataByActor` -> `ActorView.bodyColor`) to tint the rendered body,
    // and what our own ambient preview spreads in useAmbientTrafficPreview.ts.
    // Before the fix this was `undefined` for every actor, whatever the author
    // picked, because no `studio:body-color:` tag was ever emitted.
    expect(playedActors("#8C2F2F").actors[0]!.bodyColor).toBe(PAINT);
  });

  it("falls back to the default tint only when nothing is authored", () => {
    expect(playedActors(undefined).actors[0]!.bodyColor).toBeUndefined();
  });

  it("is exactly what the materializer alone loses", () => {
    // The pre-fix behaviour: the document authors a paint, the materialized
    // input carries role/class/catalog tags but no studio:body-color tag, and
    // playback therefore has nothing to tint from. This is the bug.
    const undecorated = playedActors("#8C2F2F", { decorate: false });
    expect(undecorated.actors[0]!.tags).not.toContain(`studio:body-color:${PAINT}`);
    expect(undecorated.actors[0]!.bodyColor).toBeUndefined();
  });
});
