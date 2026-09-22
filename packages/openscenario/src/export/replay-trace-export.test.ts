/**
 * Traffic lives in the authoritative trace, and nothing downstream runs it.
 *
 * A trajectory-replay export handed the authoritative trace must embed every
 * ambient actor from that trace with the engine's simulation and traffic entry
 * points unavailable, and must refuse a trace that was not simulated from the
 * exported input.
 */

import { describe, expect, it } from 'vitest';

import { contentHash, type EngineRuntime, type SimScenarioInput } from '@simforge-oss/engine';
import { engine } from '@simforge-oss/engine/node';

import {
  LANE_LEFT,
  LANE_RIGHT,
  scenario,
  syntheticGraph,
  vehicle,
} from '../../../engine/src/__tests__/fixtures/scenarios.js';
import { AsamExportError, exportOpenScenarioXml14 } from './index.js';

const graph = syntheticGraph();

/** An engine whose every simulation and traffic entry point throws. */
function trafficlessEngine(): EngineRuntime {
  const real = engine();
  const refuse = (name: string) => () => {
    throw new Error(`downstream consumer ran ${name}`);
  };
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'runSimulation' || property === 'simulation' || property === 'materializeAmbientTraffic') {
        return refuse(String(property));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Authored ego plus native ambient traffic, resolved and simulated once by the authority. */
function authoritative(): { input: SimScenarioInput; ambientIds: string[]; trace: ReturnType<EngineRuntime['runSimulation']>['trace'] } {
  const authored = scenario({
    seed: 'replay-trace-export',
    actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 60, speedMps: 10, cruiseSpeedMps: 10 })],
  });
  const generated = engine().materializeAmbientTraffic(authored, graph, {
    version: 1, preset: 'city', seed: 'ambient-1',
  } as never);
  let input = JSON.parse(generated.scenario.toJson()) as SimScenarioInput;
  let ambientIds = generated.provenance.actors.map((actor) => actor.id);
  if (ambientIds.length === 0) {
    // The synthetic straight road may be too short for the generator; tag
    // hand-placed actors exactly as the generator tags its own.
    input = scenario({
      ...input,
      actors: [
        ...input.actors,
        { ...vehicle(graph, { id: 'ambient:veh-1', rsl: LANE_RIGHT, s: 20, speedMps: 14, cruiseSpeedMps: 14 }), tags: ['ambient'] },
        { ...vehicle(graph, { id: 'ambient:veh-2', rsl: LANE_LEFT, s: 150, speedMps: 9, cruiseSpeedMps: 9 }), tags: ['ambient'] },
      ],
    } as never);
    ambientIds = ['ambient:veh-1', 'ambient:veh-2'];
  }
  const result = engine().runSimulation(input, { graph });
  return { input: result.input, ambientIds, trace: result.trace };
}

describe('trajectory-replay export from the authoritative trace', () => {
  it('embeds every ambient actor with the traffic engines unavailable', () => {
    const { input, ambientIds, trace } = authoritative();
    expect(ambientIds.length).toBeGreaterThan(0);
    const result = exportOpenScenarioXml14(input, {
      engine: trafficlessEngine(),
      graph,
      executionMode: 'trajectory-replay',
      replayTrace: trace,
      trustedAmbientActorIds: ambientIds,
    });
    const objects = result.content.split('<ScenarioObject ').slice(1);
    for (const actorId of [...ambientIds, 'ego']) {
      const object = objects.find((entry) => entry.includes(`<Property name="uniscenarios.actorId" value="${actorId}"/>`));
      expect(object, actorId).toBeDefined();
      if (actorId !== 'ego') expect(object).toContain('<Property name="uniscenarios.actorOrigin" value="canonical-ambient"/>');
    }
    // One replayed trajectory per moving actor, straight from the trace.
    expect(result.content.match(/<FollowTrajectoryAction>/g)?.length).toBe(ambientIds.length + 1);
    expect(result.content).toContain(`name="uniscenarios.trajectoryReplay.inputHash" value="${trace.header.inputHash}"`);
  });

  it('is the same document the export produces by simulating the same input itself', () => {
    const { input, ambientIds, trace } = authoritative();
    const fromTrace = exportOpenScenarioXml14(input, { engine: engine(), graph, executionMode: 'trajectory-replay', replayTrace: trace, trustedAmbientActorIds: ambientIds });
    // The self-simulated export includes warm-up ticks; the authoritative clip
    // trace does not, so only the pre-roll differs. Every clip vertex matches.
    const clipVertices = (content: string) => content.match(/<Vertex time="[^"]+">[\s\S]*?<\/Vertex>/g)!
      .filter((vertex) => Number(/time="([^"]+)"/.exec(vertex)![1]) >= input.warmupSeconds + input.dt);
    const selfSimulated = exportOpenScenarioXml14(input, { engine: engine(), graph, executionMode: 'trajectory-replay', trustedAmbientActorIds: ambientIds });
    expect(clipVertices(fromTrace.content)).toEqual(clipVertices(selfSimulated.content));
  });

  it('refuses a trace that was not simulated from the exported input', () => {
    const { input, trace } = authoritative();
    const other = { ...input, seed: 'another-seed' };
    expect(contentHash(other)).not.toBe(trace.header.inputHash);
    expect(() => exportOpenScenarioXml14(other, {
      engine: trafficlessEngine(), graph, executionMode: 'trajectory-replay', replayTrace: trace,
    })).toThrow(AsamExportError);
  });
});
