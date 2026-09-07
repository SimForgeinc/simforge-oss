import type { MapSignalPlan, MapSignalPlanClip } from '@simforge-oss/scenario';
import { MAP_SIGNAL_INDICATIONS } from '@simforge-oss/scenario';
import type {
  ControlIndication,
  SignalProgram,
} from '@simforge-oss/engine';

import type { MapSignalCatalog } from './map-signals.js';
import {
  buildSignalControlIndex,
  evaluateSignalReferencePhase,
  selectSignalPlanReference,
} from './signal-control.js';

/**
 * A plan binds by immutable map id plus exact junction, controller and head
 * ids, and every one of those is checked below. It deliberately does NOT bind
 * to a broad hash of the map's control closure: unrelated road-control
 * enrichment - a stop line added on another arm, a parking bay - must not
 * invalidate a signal plan that still names live heads.
 */
export type MapSignalPlanCompileErrorCode =
  | 'map_signal_plan_map_mismatch'
  | 'map_signal_plan_junction_unbound'
  | 'map_signal_plan_reference_unbound'
  | 'map_signal_plan_dual_ownership'
  | 'map_signal_plan_controller_conflict';

export class MapSignalPlanCompileError extends Error {
  constructor(
    readonly code: MapSignalPlanCompileErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'MapSignalPlanCompileError';
  }
}

export interface CompileMapSignalPlansOptions {
  readonly mapId: string;
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
  readonly signalCatalog: MapSignalCatalog;
  /** Resolved engine signal ids owned by legacy `@world set(signal:*.phase)`. */
  readonly worldSignalSetIds?: readonly string[];
  /** Exact compiled initial world-route geometry, keyed by engine actor id. */
  readonly worldRoutes?: Readonly<Record<string, { readonly pointsHash: string; readonly lengthM: number }>>;
}

const ENDPOINT_PAD_S = 1e-6;

function phaseAt(program: SignalProgram, timeS: number, warmupSeconds: number): ControlIndication {
  const cycle = program.phases.reduce((sum, phase) => sum + phase.durationS, 0);
  let elapsed = timeS + warmupSeconds + program.offsetS;
  if (program.loop) elapsed = ((elapsed % cycle) + cycle) % cycle;
  else if (elapsed <= 0) return program.phases[0]!.phase;
  else if (elapsed >= cycle) return program.phases[program.phases.length - 1]!.phase;
  let cursor = 0;
  for (const phase of program.phases) {
    cursor += phase.durationS;
    if (elapsed < cursor) return phase.phase;
  }
  return program.phases[program.phases.length - 1]!.phase;
}

function addBaselineBoundaries(
  into: Set<number>,
  program: SignalProgram,
  startS: number,
  endS: number,
  warmupSeconds: number,
): void {
  const cycle = program.phases.reduce((sum, phase) => sum + phase.durationS, 0);
  let cumulative = 0;
  for (const phase of program.phases) {
    cumulative += phase.durationS;
    const origin = cumulative - warmupSeconds - program.offsetS;
    if (program.loop) {
      const first = Math.ceil((startS - origin) / cycle);
      const last = Math.floor((endS - origin) / cycle);
      for (let turn = first; turn <= last; turn += 1) {
        const value = origin + turn * cycle;
        if (value > startS && value < endS) into.add(value);
      }
    } else if (origin > startS && origin < endS) {
      into.add(origin);
    }
  }
}


function validateControllerStage(
  plan: MapSignalPlan,
  reference: Pick<MapSignalPlanClip['reference'], 'controllerId' | 'headId'>,
  programs: readonly SignalProgram[],
  options: CompileMapSignalPlansOptions,
  path: string,
): void {
  const junction = options.signalCatalog.junctions.find((item) => item.junctionId === plan.binding.junctionId);
  const controller = options.signalCatalog.controllers.find((item) => item.id === reference.controllerId);
  if (!junction || !junction.controllerIds.includes(reference.controllerId) || !controller) {
    throw new MapSignalPlanCompileError(
      'map_signal_plan_reference_unbound',
      `controller "${reference.controllerId}" does not belong to junction "${plan.binding.junctionId}"`,
      `${path}.controllerId`,
    );
  }
  if (!controller.signalIds.includes(reference.headId)) {
    throw new MapSignalPlanCompileError(
      'map_signal_plan_reference_unbound',
      `head "${reference.headId}" does not belong to controller "${reference.controllerId}"`,
      `${path}.headId`,
    );
  }
  const referenceProgram = programs.find((program) =>
    program.mapBinding?.controllerHeadGroups?.some((group) =>
      group.controllerId === reference.controllerId
      && group.headIds.includes(reference.headId),
    ),
  );
  if (!referenceProgram) {
    throw new MapSignalPlanCompileError(
      'map_signal_plan_reference_unbound',
      `head "${reference.headId}" has no executable program in controller "${reference.controllerId}"`,
      path,
    );
  }
}

function compileJunction(
  programs: readonly SignalProgram[],
  plan: MapSignalPlan,
  options: CompileMapSignalPlansOptions,
  planIndex: number,
): SignalProgram[] {
  const prefix = `mapSignalPlans.${planIndex}`;
  if (plan.binding.mapId !== options.mapId) {
    throw new MapSignalPlanCompileError(
      'map_signal_plan_map_mismatch',
      `signal plan is bound to map "${plan.binding.mapId}", not "${options.mapId}"`,
      `${prefix}.binding.mapId`,
    );
  }
  // Actor-route controls make no claim on a physical junction. Their actor,
  // geometry and timing bindings are validated independently below.
  if (plan.clips.length === 0 && !plan.displayBaselines?.length && plan.routeSignals?.length) return [];
  const junctionPrograms = programs.filter((program) => program.mapBinding?.junctionId === plan.binding.junctionId);
  if (junctionPrograms.length === 0) {
    throw new MapSignalPlanCompileError(
      'map_signal_plan_junction_unbound',
      `junction "${plan.binding.junctionId}" has no executable signal programs`,
      `${prefix}.binding.junctionId`,
    );
  }
  const owned = new Set(junctionPrograms.map((program) => program.id));
  const dualOwner = options.worldSignalSetIds?.find((id) => owned.has(id));
  if (dualOwner) {
    throw new MapSignalPlanCompileError(
      'map_signal_plan_dual_ownership',
      `signal "${dualOwner}" is controlled by both mapSignalPlans and a @world set interaction`,
      prefix,
    );
  }

  const controlIndex = buildSignalControlIndex(
    junctionPrograms,
    options.signalCatalog.heads,
  );
  const displayHeadIds = new Set([
    ...(plan.displayBaselines ?? []).map((baseline) => baseline.headId),
    ...plan.clips.flatMap((clip) => clip.reference.displayHeadIds ?? []),
  ]);
  const phasesByClip = new Map<string, ReadonlyMap<string, ControlIndication>>();
  plan.clips.forEach((clip, clipIndex) => {
    const referencePath = `${prefix}.clips.${clipIndex}.reference`;
    validateControllerStage(plan, clip.reference, junctionPrograms, options, referencePath);
    clip.reference.additionalStages?.forEach((stage, stageIndex) => {
      validateControllerStage(plan, stage, junctionPrograms, options, `${referencePath}.additionalStages.${stageIndex}`);
    });
    const selection = selectSignalPlanReference(controlIndex, clip.reference);
    if (!selection || selection.junctionId !== plan.binding.junctionId) {
      throw new MapSignalPlanCompileError(
        'map_signal_plan_reference_unbound',
        `head "${clip.reference.headId}" cannot resolve an exact movement at junction "${plan.binding.junctionId}"`,
        `${prefix}.clips.${clipIndex}.reference`,
      );
    }
    const evaluation = evaluateSignalReferencePhase(controlIndex, {
      ...selection,
      movementHeadIds: selection.movementHeadIds.filter((headId) => !displayHeadIds.has(headId)),
      intersectionHeadIds: [...new Set([...selection.intersectionHeadIds, ...displayHeadIds])],
    }, {
      timeSeconds: clip.startS,
      referencePhase: clip.indication,
    });
    phasesByClip.set(clip.id, new Map(junctionPrograms.map((program) => {
      const movementOwned = (program.mapBinding?.controllerIds.length ?? 0) > 0;
      const headIds = (program.mapBinding?.headIds ?? []).filter((headId) => !movementOwned || !displayHeadIds.has(headId));
      const headStates = headIds.map((headId) => evaluation.headStates[headId] ?? 'red');
      if (headStates.length === 0 && movementOwned) headStates.push(evaluation.movementStates[program.id] ?? 'red');
      const distinct = [...new Set(headStates)];
      if (distinct.length !== 1) {
        throw new MapSignalPlanCompileError(
          'map_signal_plan_controller_conflict',
          `program "${program.id}" received incompatible physical-head states ${distinct.join(', ')}`,
          `${prefix}.clips.${clipIndex}.reference`,
        );
      }
      return [program.id, distinct[0]!] as const;
    })));
  });

  const startS = -options.warmupSeconds;
  const endS = options.clipSeconds + ENDPOINT_PAD_S;
  const points = new Set<number>([startS, 0, options.clipSeconds, endS]);
  for (const clip of plan.clips) {
    points.add(clip.startS);
    points.add(clip.endS);
  }
  for (const program of junctionPrograms) {
    addBaselineBoundaries(points, program, startS, endS, options.warmupSeconds);
  }
  const ordered = [...points].filter((point) => point >= startS && point <= endS).sort((a, b) => a - b);

  return junctionPrograms.map((program) => {
    const phases: Array<{ phase: ControlIndication; durationS: number }> = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const from = ordered[index]!;
      const to = ordered[index + 1]!;
      if (to <= from) continue;
      const sample = from + (to - from) / 2;
      const clip = plan.clips.find((candidate) => sample >= candidate.startS && sample < candidate.endS);
      const phase = clip
        ? phasesByClip.get(clip.id)!.get(program.id)!
        : phaseAt(program, sample, options.warmupSeconds);
      const previous = phases[phases.length - 1];
      if (previous?.phase === phase) previous.durationS += to - from;
      else phases.push({ phase, durationS: to - from });
    }
    return {
      ...program,
      phases,
      offsetS: 0,
      loop: false,
      mapBinding: program.mapBinding ? {
        ...program.mapBinding,
        ...((program.mapBinding.controllerIds.length > 0) ? {
          headIds: program.mapBinding.headIds.filter((headId) => !displayHeadIds.has(headId)),
          ...(program.mapBinding.controllerHeadGroups ? {
            controllerHeadGroups: program.mapBinding.controllerHeadGroups.map((group) => ({
              ...group, headIds: group.headIds.filter((headId) => !displayHeadIds.has(headId)),
            })),
          } : {}),
        } : {}),
        timingSource: 'authored' as const,
      } : undefined,
    };
  });
}

/** Expand exact movement-controlled junctions without changing baseline timing.
 * Transfer analysis and compilation share these executable IDs and lane pairs.
 * Input is the original, unsplit map program catalog. */
export function expandMapSignalMovements(
  programs: readonly SignalProgram[],
  plans: readonly MapSignalPlan[],
): SignalProgram[] {
  const splitJunctions = new Set(plans.filter((plan) => plan.clips.some((clip) => clip.reference.movements !== undefined))
    .map((plan) => plan.binding.junctionId));
  const splitIds = new Set(programs.map((program) => program.id));
  return programs.flatMap((program) => {
    const binding = program.mapBinding;
    if (!binding || !splitJunctions.has(binding.junctionId) || program.stopLines.length === 0) return [program];
    const movements: SignalProgram[] = [];
    for (const [lineIndex, line] of program.stopLines.entries()) {
      if (line.actorId !== undefined || line.connectingLaneRsls.length === 0) {
        throw new MapSignalPlanCompileError('map_signal_plan_reference_unbound',
          `program "${program.id}" lacks exact topology lane pairs for movement selection`, 'mapSignalPlans');
      }
      for (const [connectorIndex, connector] of line.connectingLaneRsls.entries()) {
        const id = `${program.id}:movement:${lineIndex}:${connectorIndex}`;
        if (splitIds.has(id)) throw new MapSignalPlanCompileError('map_signal_plan_dual_ownership', `movement program "${id}" already exists`, 'mapSignalPlans');
        splitIds.add(id);
        movements.push({
          ...program,
          id,
          stopLines: [{ ...line, connectingLaneRsls: [connector] }],
          mapBinding: {
            ...binding,
            headIds: [],
            ...(binding.controllerHeadGroups ? {
              controllerHeadGroups: binding.controllerHeadGroups.map((group) => ({ ...group, headIds: [] })),
            } : {}),
          },
        });
      }
    }
    return [{ ...program, stopLines: [] }, ...movements];
  });
}

/** Compile bounded authoring clips into complete, non-looping engine programs.
 * Baseline map timing is retained during warm-up and every uncovered gap. */
export function compileMapSignalPlans(
  programs: readonly SignalProgram[],
  plans: readonly MapSignalPlan[],
  options: CompileMapSignalPlansOptions,
): SignalProgram[] {
  let output = expandMapSignalMovements(programs, plans);
  const displayOwners = new Map<string, string>();
  const headById = new Map(options.signalCatalog.heads.map((head) => [head.id, head]));
  plans.forEach((plan, planIndex) => {
    const baselines = new Map<string, NonNullable<MapSignalPlan['displayBaselines']>[number]>();
    for (const baseline of plan.displayBaselines ?? []) {
      const path = `mapSignalPlans.${planIndex}.displayBaselines`;
      if (baselines.has(baseline.headId) || !Number.isFinite(baseline.offsetS)
        || typeof baseline.loop !== 'boolean' || baseline.phases.length === 0
        || baseline.phases.some((phase) => !Number.isFinite(phase.durationS) || phase.durationS <= 0 || !MAP_SIGNAL_INDICATIONS.includes(phase.phase))) {
        throw new MapSignalPlanCompileError('map_signal_plan_reference_unbound', `invalid or duplicate display baseline "${baseline.headId}"`, path);
      }
      baselines.set(baseline.headId, baseline);
    }
    const displayIds = new Set([
      ...baselines.keys(),
      ...plan.clips.flatMap((clip) => clip.reference.displayHeadIds ?? []),
    ]);
    for (const headId of displayIds) {
      const path = `mapSignalPlans.${planIndex}.clips`;
      const head = headById.get(headId);
      if (!head || head.kind === 'virtual') {
        throw new MapSignalPlanCompileError('map_signal_plan_reference_unbound', `display head "${headId}" is not an existing physical housing`, path);
      }
      const owner = displayOwners.get(headId);
      if (owner !== undefined) {
        throw new MapSignalPlanCompileError('map_signal_plan_dual_ownership', `display head "${headId}" is owned by multiple plans`, path);
      }
      displayOwners.set(headId, plan.id);
      const existing = output.filter((program) => program.mapBinding?.headIds.includes(headId));
      if (existing.some((program) => program.mapBinding?.junctionId !== plan.binding.junctionId)) {
        throw new MapSignalPlanCompileError('map_signal_plan_dual_ownership', `display head "${headId}" is already owned by another junction`, path);
      }
      const baseline = baselines.get(headId) ?? existing[0];
      const id = `signal:display:${headId}`;
      if (output.some((program) => program.id === id)) {
        throw new MapSignalPlanCompileError('map_signal_plan_dual_ownership', `display program "${id}" already exists with another binding`, path);
      }
      output.push({
        id,
        phases: baseline ? baseline.phases.map((phase) => ({ ...phase })) : [{ phase: 'off', durationS: 1 }],
        offsetS: baseline?.offsetS ?? 0,
        loop: baseline?.loop ?? false,
        stopLines: [],
        mapBinding: {
          junctionId: plan.binding.junctionId,
          controllerIds: [],
          headIds: [headId],
          timingSource: 'authored',
        },
      });
    }
  });
  plans.forEach((plan, planIndex) => {
    const compiled = compileJunction(output, plan, options, planIndex);
    const replacements = new Map(compiled.map((program) => [program.id, program]));
    output = output.map((program) => replacements.get(program.id) ?? program);
  });
  const programIds = new Set(output.map((program) => program.id));
  plans.forEach((plan, planIndex) => {
    const clipIds = new Set(plan.clips.map((clip) => clip.id));
    for (const signal of plan.routeSignals ?? []) {
      const path = `mapSignalPlans.${planIndex}.routeSignals`;
      const selected = new Set(signal.selectedByClipIds);
      const route = options.worldRoutes?.[signal.actorId];
      if (!route || route.pointsHash !== signal.routePointsHash
        || !/^[a-f0-9]{64}$/.test(signal.routePointsHash)
        || !Number.isFinite(route.lengthM) || route.lengthM < 0
        || !Number.isFinite(signal.s) || signal.s < 0 || signal.s > route.lengthM
        || !Number.isFinite(signal.offsetS) || typeof signal.loop !== 'boolean'
        || (signal.baselineOnly !== undefined && typeof signal.baselineOnly !== 'boolean')
        || (signal.coordinationId !== undefined && signal.coordinationId.length === 0)
        || (signal.darkFallback !== undefined && !['all_way_stop', 'uncontrolled', 'yield'].includes(signal.darkFallback))
        || (signal.darkDwellS !== undefined && (!Number.isFinite(signal.darkDwellS) || signal.darkDwellS <= 0))
        || signal.phases.length === 0
        || signal.phases.some((phase) => !Number.isFinite(phase.durationS) || phase.durationS <= 0 || !MAP_SIGNAL_INDICATIONS.includes(phase.phase))
        || selected.size !== signal.selectedByClipIds.length
        || signal.selectedByClipIds.some((id) => !clipIds.has(id))) {
        throw new MapSignalPlanCompileError('map_signal_plan_reference_unbound', `route signal "${signal.id}" lacks an exact world-route actor, timing, or clip binding`, path);
      }
      if (programIds.has(signal.id) || options.worldSignalSetIds?.includes(signal.id)) {
        throw new MapSignalPlanCompileError('map_signal_plan_dual_ownership', `route signal "${signal.id}" has conflicting ownership`, path);
      }
      programIds.add(signal.id);
      const baseline: SignalProgram = {
        id: signal.id, phases: signal.phases.map((phase) => ({ ...phase })),
        offsetS: signal.offsetS, loop: signal.loop,
        ...(signal.darkFallback !== undefined ? { darkFallback: signal.darkFallback } : {}),
        ...(signal.darkDwellS !== undefined ? { darkDwellS: signal.darkDwellS } : {}),
        stopLines: [{ actorId: signal.actorId, routePointsHash: signal.routePointsHash, rsl: '', s: signal.s, connectingLaneRsls: [] }],
        mapBinding: { junctionId: signal.coordinationId ?? plan.binding.junctionId, controllerIds: [], headIds: [], timingSource: 'authored' },
      };
      if (signal.baselineOnly) {
        output.push(baseline);
        continue;
      }
      const startS = -options.warmupSeconds;
      const endS = options.clipSeconds + ENDPOINT_PAD_S;
      const points = new Set([startS, 0, options.clipSeconds, endS]);
      for (const clip of plan.clips) { points.add(clip.startS); points.add(clip.endS); }
      addBaselineBoundaries(points, baseline, startS, endS, options.warmupSeconds);
      const ordered = [...points].filter((point) => point >= startS && point <= endS).sort((a, b) => a - b);
      const phases: SignalProgram['phases'] = [];
      for (let index = 0; index + 1 < ordered.length; index += 1) {
        const from = ordered[index]!;
        const to = ordered[index + 1]!;
        const sample = from + (to - from) / 2;
        const clip = plan.clips.find((candidate) => sample >= candidate.startS && sample < candidate.endS);
        const phase = !clip ? phaseAt(baseline, sample, options.warmupSeconds)
          : selected.has(clip.id) ? clip.indication
            : clip.indication === 'flashing_red' || clip.indication === 'flashing_yellow' ? 'flashing_red' : 'red';
        const previous = phases[phases.length - 1];
        if (previous?.phase === phase) previous.durationS += to - from;
        else phases.push({ phase, durationS: to - from });
      }
      output.push({ ...baseline, phases, offsetS: 0, loop: false });
    }
  });
  return output;
}
