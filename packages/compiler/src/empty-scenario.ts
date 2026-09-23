/**
 * The concrete world of a scenario with no authored actors (a map, optionally
 * with background traffic). Shared by the editor's scenario worker and every
 * host's authoritative simulation, so the blank world's local preview and its
 * worker trace are the same input and therefore the same digest.
 */

import {
  contentHash,
  parseSimScenarioInput,
  SIMULATION_DT_S,
  type AmbientTrafficProvenance,
  type SimScenarioInput,
} from '@simforge-oss/engine';

/**
 * The simulation core requires one actor. A blank world carries this static,
 * off-render clock body until generated traffic populates it; it is never
 * rendered, never a SUMO occupancy and never needs a catalog model.
 */
export const EMPTY_SCENARIO_CLOCK_ACTOR_ID = 'ambient-world-seed';
export const EMPTY_SCENARIO_CLOCK_TAG = 'ambient:internal-clock';
export const EMPTY_SCENARIO_SITE_ID = 'ambient-world';

/** Whether a template has no authored actors (and so binds no site). */
export function isEmptyScenarioTemplate(template: { readonly roles: readonly unknown[] }): boolean {
  return template.roles.length === 0;
}

/** Whether `actor` is the blank world's internal clock body. */
export function isEmptyScenarioClockActor(actor: { readonly id: string; readonly tags?: readonly string[] }): boolean {
  return actor.id === EMPTY_SCENARIO_CLOCK_ACTOR_ID && (actor.tags ?? []).includes(EMPTY_SCENARIO_CLOCK_TAG);
}

/** Empty authored document base. Ambient actors are ordinary runtime actors added afterward. */
export function emptyScenarioBaseInput(mapId: string): SimScenarioInput {
  return parseSimScenarioInput({
    mapId,
    clipSeconds: 20,
    warmupSeconds: 0,
    dt: SIMULATION_DT_S,
    seed: `ambient-world:${mapId}`,
    actors: [{
      id: EMPTY_SCENARIO_CLOCK_ACTOR_ID,
      kind: 'static_object',
      static: true,
      initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } },
      tags: [EMPTY_SCENARIO_CLOCK_TAG],
    }],
    physics: { mode: 'dynamic-v1' },
  });
}

/**
 * Keep the clock only while no generated actor exists (SUMO or `off`
 * traffic); drop it as soon as native ambient actors populate the world.
 */
export function withoutRedundantEmptyScenarioClock<T extends { readonly input: SimScenarioInput; readonly provenance: AmbientTrafficProvenance }>(
  populated: T,
): T {
  if (populated.provenance.actors.length === 0) return populated;
  return {
    ...populated,
    input: { ...populated.input, actors: populated.input.actors.filter((actor) => !isEmptyScenarioClockActor(actor)) },
  };
}

/** Materialization manifest of a blank world (no site, no authored actors). */
export function emptyScenarioManifest(mapId: string, engineGraphDigest: string, baseInput: SimScenarioInput): {
  readonly instanceId: string;
  readonly inputHash: string;
  readonly replayKey: { readonly mapId: string; readonly engineGraphDigest: string; readonly siteId: string };
  readonly actors: readonly never[];
} {
  return {
    instanceId: `${EMPTY_SCENARIO_SITE_ID}:${mapId}`,
    inputHash: contentHash(baseInput),
    replayKey: { mapId, engineGraphDigest, siteId: EMPTY_SCENARIO_SITE_ID },
    actors: [],
  };
}
