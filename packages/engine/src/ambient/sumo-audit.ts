/**
 * Red-light audit of merged SUMO traffic against the signal heads every
 * renderer draws.
 *
 * For each SUMO vehicle in the authoritative trace, every crossing of a
 * signalized stop line (the end of a traffic-light-controlled SUMO approach
 * lane) is located, the movement it then takes is identified from the lane it
 * leaves the junction on, and the recorded signal book — the channel the
 * renderers paint on the physical heads — is read at the crossing tick. A
 * crossing while that movement's governing heads show red is a violation.
 */

import type { ControlIndication, RoadControl, SignalProgram } from '../schema/input.js';
import type { SimTrace } from '../trace/trace.js';
import { traceToSceneFrame } from '../trace/trace.js';
import { sumoNetworkToScene, type SumoNetworkWorldTransform } from './sumo.js';
import {
  bindSumoLinksToSignalPrograms,
  parseSumoSignalNetwork,
  type SumoLinkBindingSource,
} from './sumo-signals.js';

export interface SumoRedLightCrossing {
  readonly actorId: string;
  readonly t: number;
  readonly tlId: string;
  readonly linkIndex: number;
  readonly binding: SumoLinkBindingSource;
  readonly programIds: readonly string[];
  readonly phases: readonly ControlIndication[];
}

export interface SumoSignalAudit {
  /** Stop-line crossings by SUMO vehicles at traffic-light approaches. */
  readonly crossings: number;
  /** Crossings whose movement could not be identified before the clip ended. */
  readonly unresolved: number;
  readonly crossingsByBinding: Readonly<Record<SumoLinkBindingSource, number>>;
  /** Crossings on red of a movement SimForge governs (`stop-line` or `head`). */
  readonly redViolations: readonly SumoRedLightCrossing[];
  /**
   * Crossings on movements SimForge does not signal (`none`) while a head
   * netconvert tied to the movement showed red. Not SUMO violations: the
   * SimForge book lets these movements go; listed as control-plan gaps.
   */
  readonly unsignalledOnRedHead: readonly SumoRedLightCrossing[];
}

const RED: ReadonlySet<ControlIndication> = new Set(['red', 'red_x', 'stop']);

export function auditSumoSignalCompliance(options: {
  readonly trace: SimTrace;
  /** The map's SUMO network (original or synthesized; only geometry and provenance are read). */
  readonly networkXml: string;
  readonly transform: SumoNetworkWorldTransform;
  readonly signalPrograms: readonly SignalProgram[];
  readonly roadControls?: readonly RoadControl[];
  /** Actor ids to audit; default: every `sumo:` actor. */
  readonly actorIds?: readonly string[];
}): SumoSignalAudit {
  const network = parseSumoSignalNetwork(options.networkXml);
  const bindings = bindSumoLinksToSignalPrograms(network, options.signalPrograms, options.roadControls ?? []);
  const shapes = laneShapes(options.networkXml, options.transform);
  const programsByHead = new Map<string, string[]>();
  for (const program of options.signalPrograms) {
    for (const head of program.mapBinding?.headIds ?? []) programsByHead.set(head, [...(programsByHead.get(head) ?? []), program.id]);
  }
  const approaches = new Map<string, { stop: Point; along: Point; halfWidth: number; links: { index: number; exit: Point }[] }>();
  network.links.forEach((link, index) => {
    const approach = shapes.get(link.fromLane);
    const exit = shapes.get(link.toLane);
    if (!approach || approach.points.length < 2 || !exit) return;
    const b = approach.points[approach.points.length - 1]!;
    const a = approach.points[approach.points.length - 2]!;
    const length = Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    if (!(length > 0)) return;
    const entry = approaches.get(link.fromLane) ?? {
      stop: b,
      along: { x: (b.x - a.x) / length, z: (b.z - a.z) / length },
      halfWidth: approach.width / 2,
      links: [],
    };
    entry.links.push({ index, exit: exit.points[0]! });
    approaches.set(link.fromLane, entry);
  });

  const scene = traceToSceneFrame(options.trace);
  const ids = options.actorIds ?? Object.keys(scene.ticks.actors).filter((id) => id.startsWith('sumo:')).sort();
  const signals = options.trace.ticks.signals ?? {};
  const crossingsByBinding: Record<SumoLinkBindingSource, number> = { 'stop-line': 0, head: 0, 'road-control': 0, none: 0 };
  const redViolations: SumoRedLightCrossing[] = [];
  const unsignalledOnRedHead: SumoRedLightCrossing[] = [];
  let crossings = 0;
  let unresolved = 0;
  for (const actorId of ids) {
    const track = scene.ticks.actors[actorId];
    if (!track) continue;
    for (let tick = 1; tick < track.x.length; tick += 1) {
      if (track.present[tick] !== 1 || track.present[tick - 1] !== 1) continue;
      for (const approach of approaches.values()) {
        const before = along(approach, track.x[tick - 1]!, track.z[tick - 1]!);
        const after = along(approach, track.x[tick]!, track.z[tick]!);
        if (!(before.d < 0 && after.d >= 0 && after.e <= approach.halfWidth + 0.75)) continue;
        crossings += 1;
        const taken = movementTaken(approach.links, track, tick);
        if (taken === null) {
          unresolved += 1;
          continue;
        }
        const link = network.links[taken]!;
        const binding = bindings[taken]!;
        crossingsByBinding[binding.source] += 1;
        const phaseOf = (programId: string) => signals[programId]?.phase[tick];
        if (binding.source === 'stop-line' || binding.source === 'head') {
          const phases = binding.programIds.map(phaseOf).filter((phase): phase is ControlIndication => phase !== undefined);
          if (phases.some((phase) => RED.has(phase))) {
            redViolations.push({ actorId, t: options.trace.ticks.t[tick]!, tlId: link.tlId, linkIndex: link.linkIndex, binding: binding.source, programIds: binding.programIds, phases });
          }
        } else if (binding.source === 'none') {
          const programIds = [...new Set(link.headIds.flatMap((head) => programsByHead.get(head) ?? []))].sort();
          const phases = programIds.map(phaseOf).filter((phase): phase is ControlIndication => phase !== undefined);
          if (phases.length > 0 && phases.every((phase) => RED.has(phase))) {
            unsignalledOnRedHead.push({ actorId, t: options.trace.ticks.t[tick]!, tlId: link.tlId, linkIndex: link.linkIndex, binding: 'none', programIds, phases });
          }
        }
      }
    }
  }
  return { crossings, unresolved, crossingsByBinding, redViolations, unsignalledOnRedHead };
}

interface Point { readonly x: number; readonly z: number }

function along(approach: { stop: Point; along: Point }, x: number, z: number): { d: number; e: number } {
  const dx = x - approach.stop.x;
  const dz = z - approach.stop.z;
  return { d: dx * approach.along.x + dz * approach.along.z, e: Math.abs(dx * approach.along.z - dz * approach.along.x) };
}

/** The link whose exit lane start the vehicle reaches first after the crossing. */
function movementTaken(
  links: readonly { index: number; exit: Point }[],
  track: { x: number[]; z: number[]; present: number[] },
  from: number,
): number | null {
  for (let tick = from; tick < track.x.length && track.present[tick] === 1; tick += 1) {
    let best: { index: number; d2: number } | null = null;
    for (const link of links) {
      const d2 = (track.x[tick]! - link.exit.x) ** 2 + (track.z[tick]! - link.exit.z) ** 2;
      if (d2 <= 2.5 * 2.5 && (!best || d2 < best.d2)) best = { index: link.index, d2 };
    }
    if (best) return best.index;
  }
  return links.length === 1 ? links[0]!.index : null;
}

function laneShapes(networkXml: string, transform: SumoNetworkWorldTransform): Map<string, { points: Point[]; width: number }> {
  const shapes = new Map<string, { points: Point[]; width: number }>();
  for (const match of networkXml.matchAll(/<lane\b([^>]*?)(?:\/>|>)/g)) {
    const id = /(?:^|\s)id="([^"]+)"/.exec(match[1]!)?.[1];
    const shape = /\sshape="([^"]+)"/.exec(match[1]!)?.[1];
    if (!id || !shape) continue;
    const width = Number(/\swidth="([^"]+)"/.exec(match[1]!)?.[1] ?? 3.2);
    const points = shape.trim().split(/\s+/).map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return sumoNetworkToScene({ x: x!, y: y! }, transform);
    });
    shapes.set(id, { points, width });
  }
  return shapes;
}
