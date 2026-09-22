/**
 * SUMO traffic lights driven by the SimForge signal book.
 *
 * netconvert builds its own tlLogic from junction geometry: a default fixed
 * program whose phase count, order and timing have nothing to do with the
 * OpenDRIVE controllers (on Richmond Field Station it is a two-phase 42/3/42/3
 * program; the SimForge book runs the four OpenDRIVE controllers one after the
 * other at 12 s green + 3 s yellow). Running SUMO on that program makes its
 * vehicles cross while the heads every renderer draws are red.
 *
 * The worker therefore rewrites every tlLogic from the resolved input's
 * `signalPrograms` before SUMO starts. Each controlled SUMO link is bound to
 * the SimForge programs whose stop line sits on the link's approach lane and
 * whose movement filter names the link's junction lane — exactly the rule the
 * engine uses to decide whether an actor brakes for that line — and the link's
 * state at every fixed step is the program indication at that instant. The
 * SimForge book is then the only signal authority; SUMO merely obeys it.
 */

import type { ControlIndication, RoadControl, SignalProgram } from '../schema/input.js';

/** One SUMO connection that a traffic light controls. */
export interface SumoControlledLink {
  readonly tlId: string;
  readonly linkIndex: number;
  readonly fromEdge: string;
  readonly toEdge: string;
  readonly fromLane: string;
  readonly toLane: string;
  readonly via: string | null;
  readonly dir: string;
  /** OpenDRIVE `road_lane` identities of the approach lane (`origId`). */
  readonly fromOrigIds: readonly string[];
  /** OpenDRIVE `road_lane` identities of the junction lane (`origId` of `via`). */
  readonly viaOrigIds: readonly string[];
  /** Physical OpenDRIVE heads netconvert associated with this link (`linkSignalID`). */
  readonly headIds: readonly string[];
}

export interface SumoTrafficLightLogic {
  readonly id: string;
  readonly programId: string;
  readonly type: string;
  readonly offset: number;
  readonly phases: readonly { readonly duration: number; readonly state: string }[];
  readonly linkCount: number;
}

export interface SumoSignalNetwork {
  readonly trafficLights: readonly SumoTrafficLightLogic[];
  readonly links: readonly SumoControlledLink[];
}

/** SUMO link-state characters (sumo.dlr.de/docs/Simulation/Traffic_Lights.html). */
export type SumoLinkState = 'G' | 'g' | 'y' | 'r' | 's' | 'o' | 'O';

/**
 * How a link was bound:
 * - `stop-line`: a SimForge program's stop line and movement filter name this
 *   movement, exactly the engine's own braking rule;
 * - `head`: no stop line names it, but netconvert tied the link to a head that
 *   a program drives and that program already controls this approach road
 *   (a control-plan gap: SUMO obeys the head the renderers draw);
 * - `road-control`: a SimForge stop control governs it (SUMO `s`);
 * - `none`: nothing governs it; SUMO yields (`o`).
 */
export type SumoLinkBindingSource = 'stop-line' | 'head' | 'road-control' | 'none';

export interface SumoLinkBinding {
  readonly tlId: string;
  readonly linkIndex: number;
  readonly source: SumoLinkBindingSource;
  readonly programIds: readonly string[];
  readonly roadControlIds: readonly string[];
}

export interface SumoSignalSynthesisReport {
  readonly trafficLights: number;
  readonly controlledLinks: number;
  /** Links whose movement a SimForge program controls (`stop-line` + `head`). */
  readonly boundLinks: number;
  readonly linksBySource: Readonly<Record<SumoLinkBindingSource, number>>;
  /** `tl:index` of links bound only through head provenance (SimForge control-plan gaps). */
  readonly headFallbackLinks: readonly string[];
  /** Controlled links nothing governs; they yield (`o`). */
  readonly unboundLinks: number;
  /** SUMO traffic lights without a single bound link (run as all-yield). */
  readonly unboundTrafficLights: readonly string[];
  /** SimForge programs that bind no SUMO link (their stop lines are not SUMO movements). */
  readonly unusedProgramIds: readonly string[];
  readonly phasesWritten: number;
}

export interface SumoSignalSynthesis {
  readonly xml: string;
  readonly bindings: readonly SumoLinkBinding[];
  readonly report: SumoSignalSynthesisReport;
}

/**
 * The indication at one SUMO step. `stepIndication(programIndex, step)` must
 * return what the SimForge program shows during SUMO step `step`
 * (SUMO time `[step·dt, (step+1)·dt)`).
 */
export type SumoStepIndication = (program: SignalProgram, step: number) => ControlIndication;

export function parseSumoSignalNetwork(networkXml: string): SumoSignalNetwork {
  const laneOrigIds = new Map<string, string[]>();
  for (const match of networkXml.matchAll(/<lane\b([^>]*?)(\/>|>([\s\S]*?)<\/lane>)/g)) {
    const id = attribute(match[1]!, 'id');
    if (!id) continue;
    const origIds: string[] = [];
    for (const param of (match[3] ?? '').matchAll(/<param\b([^>]*?)\/?>/g)) {
      if (attribute(param[1]!, 'key') !== 'origId') continue;
      origIds.push(...(attribute(param[1]!, 'value') ?? '').trim().split(/\s+/).filter(Boolean));
    }
    laneOrigIds.set(id, origIds);
  }
  const headsByLink = new Map<string, Set<string>>();
  const addHeads = (key: string, value: string | undefined) => {
    const ids = (value ?? '').trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return;
    const set = headsByLink.get(key) ?? new Set<string>();
    ids.forEach((id) => set.add(id));
    headsByLink.set(key, set);
  };
  for (const match of networkXml.matchAll(/<tlLogic\b([^>]*)>([\s\S]*?)<\/tlLogic>/g)) {
    const tlId = attribute(match[1]!, 'id') ?? '';
    for (const param of match[2]!.matchAll(/<param\b([^>]*?)\/?>/g)) {
      const index = /^linkSignalID:(\d+)$/.exec(attribute(param[1]!, 'key') ?? '')?.[1];
      if (index !== undefined) addHeads(`${tlId}:${index}`, attribute(param[1]!, 'value'));
    }
  }
  for (const match of networkXml.matchAll(/<connection\b([^>]*?)>([\s\S]*?)<\/connection>/g)) {
    const tlId = attribute(match[1]!, 'tl');
    const index = attribute(match[1]!, 'linkIndex');
    if (!tlId || index === undefined) continue;
    for (const param of match[2]!.matchAll(/<param\b([^>]*?)\/?>/g)) {
      if (attribute(param[1]!, 'key') === 'signalID') addHeads(`${tlId}:${index}`, attribute(param[1]!, 'value'));
    }
  }
  const links: SumoControlledLink[] = [];
  for (const match of networkXml.matchAll(/<connection\b([^>]*?)\/?>/g)) {
    const attrs = match[1]!;
    const tlId = attribute(attrs, 'tl');
    const linkIndex = Number(attribute(attrs, 'linkIndex'));
    if (!tlId || !Number.isInteger(linkIndex)) continue;
    const fromEdge = attribute(attrs, 'from') ?? '';
    const fromLane = `${fromEdge}_${attribute(attrs, 'fromLane') ?? ''}`;
    const via = attribute(attrs, 'via') ?? null;
    links.push({
      tlId,
      linkIndex,
      fromEdge,
      toEdge: attribute(attrs, 'to') ?? '',
      fromLane,
      toLane: `${attribute(attrs, 'to') ?? ''}_${attribute(attrs, 'toLane') ?? ''}`,
      via,
      dir: attribute(attrs, 'dir') ?? '',
      fromOrigIds: laneOrigIds.get(fromLane) ?? [],
      viaOrigIds: via ? laneOrigIds.get(via) ?? [] : [],
      headIds: [...(headsByLink.get(`${tlId}:${linkIndex}`) ?? [])].sort(compare),
    });
  }
  links.sort((left, right) => compare(left.tlId, right.tlId) || left.linkIndex - right.linkIndex);
  const trafficLights: SumoTrafficLightLogic[] = [];
  for (const match of networkXml.matchAll(/<tlLogic\b([^>]*)>([\s\S]*?)<\/tlLogic>/g)) {
    const id = attribute(match[1]!, 'id') ?? '';
    const phases = [...match[2]!.matchAll(/<phase\b([^>]*?)\/?>/g)].map((phase) => ({
      duration: Number(attribute(phase[1]!, 'duration')),
      state: attribute(phase[1]!, 'state') ?? '',
    }));
    trafficLights.push({
      id,
      programId: attribute(match[1]!, 'programID') ?? '0',
      type: attribute(match[1]!, 'type') ?? 'static',
      offset: Number(attribute(match[1]!, 'offset') ?? 0),
      phases,
      linkCount: phases[0]?.state.length ?? 0,
    });
  }
  trafficLights.sort((left, right) => compare(left.id, right.id));
  return { trafficLights, links };
}

/**
 * Bind every controlled link to what governs its movement in SimForge (see
 * {@link SumoLinkBindingSource}). A stop line governs a link when it sits on
 * the link's approach lane and either names no movement filter or names the
 * link's junction lane — the engine's own braking rule.
 */
export function bindSumoLinksToSignalPrograms(
  network: SumoSignalNetwork,
  programs: readonly SignalProgram[],
  roadControls: readonly RoadControl[] = [],
): readonly SumoLinkBinding[] {
  const programIndex = stopLineIndex([...programs].sort((left, right) => compare(left.id, right.id)));
  const controlIndex = stopLineIndex([...roadControls].sort((left, right) => compare(left.id, right.id)));
  const programsByHead = new Map<string, SignalProgram[]>();
  for (const program of [...programs].sort((left, right) => compare(left.id, right.id))) {
    for (const head of program.mapBinding?.headIds ?? []) {
      const list = programsByHead.get(head) ?? [];
      list.push(program);
      programsByHead.set(head, list);
    }
  }
  return network.links.map((link) => {
    const base = { tlId: link.tlId, linkIndex: link.linkIndex };
    const programIds = governing(programIndex, link);
    if (programIds.length > 0) return { ...base, source: 'stop-line' as const, programIds, roadControlIds: [] };
    const roadControlIds = governing(controlIndex, link);
    if (roadControlIds.length > 0) return { ...base, source: 'road-control' as const, programIds: [], roadControlIds };
    const approachRoads = new Set(link.fromOrigIds.map(roadOf));
    const headPrograms = new Set<string>();
    for (const head of link.headIds) {
      for (const program of programsByHead.get(head) ?? []) {
        if ((program.stopLines ?? []).some((stopLine) => approachRoads.has(roadOf(roadLaneKey(stopLine.rsl) ?? '')))) {
          headPrograms.add(program.id);
        }
      }
    }
    if (headPrograms.size > 0) {
      return { ...base, source: 'head' as const, programIds: [...headPrograms].sort(compare), roadControlIds: [] };
    }
    return { ...base, source: 'none' as const, programIds: [], roadControlIds: [] };
  });
}

type StopLineIndex = Map<string, { id: string; connecting: ReadonlySet<string> }[]>;

function stopLineIndex(
  controls: readonly { readonly id: string; readonly stopLines?: readonly { readonly rsl: string; readonly connectingLaneRsls?: readonly string[] }[] }[],
): StopLineIndex {
  const index: StopLineIndex = new Map();
  for (const control of controls) {
    for (const stopLine of control.stopLines ?? []) {
      const approach = roadLaneKey(stopLine.rsl);
      if (!approach) continue;
      const list = index.get(approach) ?? [];
      list.push({
        id: control.id,
        connecting: new Set((stopLine.connectingLaneRsls ?? []).map(roadLaneKey).filter((key): key is string => key !== null)),
      });
      index.set(approach, list);
    }
  }
  return index;
}

function governing(index: StopLineIndex, link: SumoControlledLink): string[] {
  const ids = new Set<string>();
  for (const approach of link.fromOrigIds) {
    for (const candidate of index.get(approach) ?? []) {
      if (candidate.connecting.size === 0 || link.viaOrigIds.some((via) => candidate.connecting.has(via))) ids.add(candidate.id);
    }
  }
  return [...ids].sort(compare);
}

function roadOf(roadLane: string): string {
  const cut = roadLane.lastIndexOf('_');
  return cut < 0 ? roadLane : roadLane.slice(0, cut);
}

/**
 * SimForge indication → SUMO link state.
 *
 * Green is written as minor green `g`: SUMO then still applies the junction's
 * own foe/response matrix between simultaneously green movements (a permissive
 * left keeps yielding to opposing through traffic), which is what the SimForge
 * book means by a green ball. A dark head follows the program's
 * `darkFallback` (default all-way stop, `s`: stop, then proceed).
 */
export function sumoLinkStateForIndication(
  indication: ControlIndication,
  darkFallback: SignalProgram['darkFallback'] = 'all_way_stop',
): SumoLinkState {
  switch (indication) {
    case 'green':
    case 'green_arrow':
    case 'proceed':
      return 'g';
    case 'yellow':
    case 'yellow_arrow':
      return 'y';
    case 'red':
    case 'red_x':
    case 'stop':
      return 'r';
    case 'flashing_yellow':
    case 'flashing_yellow_arrow':
      return 'o';
    case 'flashing_red':
    case 'flashing_red_arrow':
      return 's';
    case 'off':
      return darkFallback === 'uncontrolled' ? 'O' : darkFallback === 'yield' ? 'o' : 's';
  }
}

/** A link governed by several programs shows the most restrictive state. */
const RESTRICTION: Readonly<Record<SumoLinkState, number>> = { r: 6, y: 5, s: 4, o: 3, g: 2, G: 1, O: 0 };

export function mostRestrictiveSumoLinkState(states: readonly SumoLinkState[]): SumoLinkState {
  let result: SumoLinkState = 'o';
  let rank = -1;
  for (const state of states) {
    if (RESTRICTION[state] > rank) {
      rank = RESTRICTION[state];
      result = state;
    }
  }
  return result;
}

/**
 * The SimForge engine's program evaluation (`SignalBook::state_at_index`),
 * reproduced operation for operation so the IEEE results are identical: the
 * phase at simulation time `t` of a program started at `-warmupSeconds + offsetS`.
 */
export function signalProgramIndicationAt(
  program: SignalProgram,
  t: number,
  warmupSeconds: number,
): ControlIndication {
  const cycle = program.phases.reduce((sum, phase) => sum + phase.durationS, 0);
  let elapsed = t + warmupSeconds + (program.offsetS ?? 0);
  if (program.loop ?? true) {
    elapsed = ((elapsed % cycle) + cycle) % cycle;
  } else if (elapsed < 0) {
    return program.phases[0]!.phase;
  } else if (elapsed >= cycle) {
    return program.phases[program.phases.length - 1]!.phase;
  }
  let accumulated = 0;
  for (const phase of program.phases) {
    accumulated += phase.durationS;
    if (elapsed < accumulated) return phase.phase;
  }
  return program.phases[program.phases.length - 1]!.phase;
}

/**
 * Replace every tlLogic with a static program that reproduces the bound
 * SimForge indications step by step for `stepCount` steps of `stepSeconds`,
 * then holds the last state. Durations are whole multiples of the step, which
 * SUMO represents exactly (integer milliseconds).
 */
export function synthesizeSumoSignalPrograms(
  networkXml: string,
  programs: readonly SignalProgram[],
  options: {
    readonly stepSeconds: number;
    readonly stepCount: number;
    readonly indication: SumoStepIndication;
    readonly roadControls?: readonly RoadControl[];
  },
): SumoSignalSynthesis {
  const stepMilliseconds = Math.round(options.stepSeconds * 1000);
  if (!(stepMilliseconds > 0) || Math.abs(stepMilliseconds / 1000 - options.stepSeconds) > 1e-12) {
    throw new Error('SUMO signal synthesis needs a whole-millisecond step');
  }
  if (!Number.isInteger(options.stepCount) || options.stepCount < 1) {
    throw new Error('SUMO signal synthesis needs at least one step');
  }
  const network = parseSumoSignalNetwork(networkXml);
  const bindings = bindSumoLinksToSignalPrograms(network, programs, options.roadControls ?? []);
  const programById = new Map(programs.map((program) => [program.id, program]));
  const bindingsByTl = new Map<string, SumoLinkBinding[]>();
  for (const binding of bindings) {
    const list = bindingsByTl.get(binding.tlId) ?? [];
    list.push(binding);
    bindingsByTl.set(binding.tlId, list);
  }
  const usedPrograms = new Set(bindings.flatMap((binding) => binding.programIds));
  const unboundTrafficLights: string[] = [];
  const phaseXmlByTl = new Map<string, string>();
  let phasesWritten = 0;
  for (const logic of network.trafficLights) {
    const linkCount = logic.linkCount;
    const linkPrograms: (readonly SignalProgram[])[] = Array.from({ length: linkCount }, () => []);
    const stopControlled = new Set<number>();
    for (const binding of bindingsByTl.get(logic.id) ?? []) {
      if (binding.linkIndex >= linkCount) continue;
      linkPrograms[binding.linkIndex] = binding.programIds.map((id) => programById.get(id)!);
      if (binding.source === 'road-control') stopControlled.add(binding.linkIndex);
    }
    if (linkPrograms.every((list) => list.length === 0)) unboundTrafficLights.push(logic.id);
    // Programs are evaluated once per step and shared by every link they bind.
    const distinct = [...new Set(linkPrograms.flat())].sort((left, right) => compare(left.id, right.id));
    const phases: { steps: number; state: string }[] = [];
    for (let step = 0; step < options.stepCount; step += 1) {
      const indications = new Map(distinct.map((program) => [program, sumoLinkStateForIndication(
        options.indication(program, step),
        program.darkFallback,
      )]));
      let state = '';
      for (let link = 0; link < linkCount; link += 1) {
        const governing = linkPrograms[link]!;
        state += governing.length === 0
          ? (stopControlled.has(link) ? 's' : 'o')
          : mostRestrictiveSumoLinkState(governing.map((program) => indications.get(program)!));
      }
      const last = phases[phases.length - 1];
      if (last && last.state === state) last.steps += 1;
      else phases.push({ steps: 1, state });
    }
    // Hold the final state far beyond the run so SUMO never wraps the cycle.
    phases[phases.length - 1]!.steps += Math.ceil(86_400_000 / stepMilliseconds);
    phasesWritten += phases.length;
    phaseXmlByTl.set(logic.id, phases.map((phase) =>
      `        <phase duration="${formatMilliseconds(phase.steps * stepMilliseconds)}" state="${phase.state}"/>`).join('\n'));
  }
  const xml = networkXml.replace(/<tlLogic\b([^>]*)>([\s\S]*?)<\/tlLogic>/g, (_whole, attrs: string, body: string) => {
    const id = attribute(attrs, 'id') ?? '';
    const phaseXml = phaseXmlByTl.get(id);
    if (phaseXml === undefined) return _whole;
    const params = [...body.matchAll(/<param\b[^>]*?\/?>/g)].map((param) => `        ${param[0]}`).join('\n');
    const open = attrs
      .replace(/\btype="[^"]*"/, 'type="static"')
      .replace(/\boffset="[^"]*"/, 'offset="0"');
    return `<tlLogic${open}>\n${phaseXml}${params ? `\n${params}` : ''}\n    </tlLogic>`;
  });
  const controlledLinks = network.links.length;
  const boundLinks = bindings.filter((binding) => binding.programIds.length > 0).length;
  const linksBySource: Record<SumoLinkBindingSource, number> = { 'stop-line': 0, head: 0, 'road-control': 0, none: 0 };
  bindings.forEach((binding) => { linksBySource[binding.source] += 1; });
  return {
    xml,
    bindings,
    report: {
      trafficLights: network.trafficLights.length,
      controlledLinks,
      boundLinks,
      linksBySource,
      headFallbackLinks: bindings.filter((binding) => binding.source === 'head').map((binding) => `${binding.tlId}:${binding.linkIndex}`),
      unboundLinks: linksBySource.none,
      unboundTrafficLights,
      unusedProgramIds: programs.map((program) => program.id).filter((id) => !usedPrograms.has(id)).sort(compare),
      phasesWritten,
    },
  };
}

/** `road:section:lane` (SimForge) or `road_lane` (SUMO origId) → `road_lane`. */
export function roadLaneKey(rsl: string): string | null {
  const parts = rsl.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[2]) return null;
  return `${parts[0]}_${parts[2]}`;
}

function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.trunc(milliseconds / 1000);
  const remainder = milliseconds % 1000;
  return remainder === 0 ? String(seconds) : `${seconds}.${String(remainder).padStart(3, '0').replace(/0+$/, '')}`;
}

function attribute(source: string, name: string): string | undefined {
  const value = source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : value
    .replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/** UTF-16 code-unit order, independent of locale. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
