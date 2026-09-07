import type { ControlIndication, SignalProgram } from '@simforge-oss/engine';
import type { MapSignalPlanClip } from '@simforge-oss/scenario';

export type SignalControlDiagnosticCode =
  | 'unresolved_head'
  | 'unresolved_movement'
  | 'shared_head'
  | 'conflicting_controller_stage'
  | 'missing_controller_stage';

export interface SignalControlDiagnostic {
  readonly code: SignalControlDiagnosticCode;
  readonly message: string;
  readonly headIds?: readonly string[];
  readonly movementIds?: readonly string[];
  readonly controllerIds?: readonly string[];
}

/** The executable movement grain currently authored by Studio. One program may
 * govern several approach/connecting-lane pairs, but it has one phase at t. */
export interface SignalMovementBinding {
  readonly id: string;
  readonly programId: string;
  readonly junctionId: string;
  readonly controllerIds: readonly string[];
  readonly headIds: readonly string[];
  readonly approachLaneRsls: readonly string[];
  readonly connectingLaneRsls: readonly string[];
  readonly lanePairs?: readonly { readonly approachLaneRsl: string; readonly connectingLaneRsl: string }[];
}

export interface SignalControllerBinding {
  readonly id: string;
  readonly junctionId: string;
  readonly headIds: readonly string[];
  readonly movementIds: readonly string[];
}

export interface SignalHeadControlBinding {
  readonly id: string;
  readonly junctionIds: readonly string[];
  readonly controllerIds: readonly string[];
  readonly movementIds: readonly string[];
  /** False means the physical head exists but no exact program/controller owns it. */
  readonly resolved: boolean;
}

export interface SignalJunctionControlBinding {
  readonly id: string;
  readonly controllerIds: readonly string[];
  readonly movementIds: readonly string[];
  readonly headIds: readonly string[];
}

export interface SignalControlIndex {
  readonly heads: ReadonlyMap<string, SignalHeadControlBinding>;
  readonly movements: ReadonlyMap<string, SignalMovementBinding>;
  readonly controllers: ReadonlyMap<string, SignalControllerBinding>;
  readonly junctions: ReadonlyMap<string, SignalJunctionControlBinding>;
  readonly diagnostics: readonly SignalControlDiagnostic[];
  readonly physicalHeadIds?: ReadonlySet<string>;
}

export interface SignalReferenceSelection {
  readonly selectedHeadId: string;
  readonly referenceMovementId: string;
  /** Exact authoritative OpenDRIVE controller stage selected for authoring. */
  readonly referenceControllerId: string;
  readonly junctionId: string;
  readonly controllerIds: readonly string[];
  readonly stageMovementIds: readonly string[];
  readonly movementHeadIds: readonly string[];
  readonly intersectionHeadIds: readonly string[];
  readonly relatedMovementIds: readonly string[];
  readonly diagnostics: readonly SignalControlDiagnostic[];
  /** Explicit display-only housings; never executable movement membership. */
  readonly displayHeadIds?: readonly string[];
}

export interface SignalReferenceEvaluationInput {
  readonly timeSeconds: number;
  /** The selected reference movement's authored phase at `timeSeconds`. */
  readonly referencePhase: ControlIndication;
  /** Optional competing authored requests for sibling movements at the same instant. */
  readonly movementPhases?: Readonly<Record<string, ControlIndication>>;
}

export interface SignalReferenceEvaluationResult {
  readonly timeSeconds: number;
  readonly headStates: Readonly<Record<string, ControlIndication>>;
  readonly movementStates: Readonly<Record<string, ControlIndication>>;
  readonly diagnostics: readonly SignalControlDiagnostic[];
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function add(map: Map<string, Set<string>>, key: string, values: Iterable<string>): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  for (const value of values) set.add(value);
}

/** Build exact reverse indices from executable programs and their preserved
 * OpenDRIVE controller-stage metadata. No geometric/proximity inference occurs. */
export function buildSignalControlIndex(
  programs: readonly SignalProgram[],
  catalogHeads: readonly (string | { readonly id: string; readonly kind?: 'physical' | 'virtual' })[] = [],
): SignalControlIndex {
  const physicalHeadIds = new Set(catalogHeads.flatMap((head) =>
    typeof head === 'string' ? [head] : head.kind === 'virtual' ? [] : [head.id],
  ));
  const diagnostics: SignalControlDiagnostic[] = [];
  const movements = new Map<string, SignalMovementBinding>();
  const headsToMovements = new Map<string, Set<string>>();
  const headsToControllers = new Map<string, Set<string>>();
  const headsToJunctions = new Map<string, Set<string>>();
  const controllerHeads = new Map<string, Set<string>>();
  const controllerMovements = new Map<string, Set<string>>();
  const controllerJunction = new Map<string, string>();
  const junctionHeads = new Map<string, Set<string>>();
  const junctionControllers = new Map<string, Set<string>>();
  const junctionMovements = new Map<string, Set<string>>();

  for (const program of [...programs].sort((a, b) => a.id.localeCompare(b.id))) {
    const binding = program.mapBinding;
    if (!binding) {
      diagnostics.push({
        code: 'unresolved_movement',
        message: `Signal movement ${program.id} has no physical map binding.`,
        movementIds: [program.id],
      });
      continue;
    }
    const headIds = unique(binding.headIds);
    const controllerIds = unique(binding.controllerIds);
    if (!binding.controllerHeadGroups) {
      diagnostics.push({
        code: 'missing_controller_stage',
        message: `Signal movement ${program.id} lacks exact controller-stage membership.`,
        movementIds: [program.id],
        controllerIds,
      });
    }
    const movement: SignalMovementBinding = {
      id: program.id,
      programId: program.id,
      junctionId: binding.junctionId,
      controllerIds,
      headIds,
      approachLaneRsls: unique(program.stopLines.map((line) => line.rsl)),
      connectingLaneRsls: unique(program.stopLines.flatMap((line) => line.connectingLaneRsls)),
      lanePairs: program.stopLines.flatMap((line) => line.connectingLaneRsls.map((connectingLaneRsl) => ({
        approachLaneRsl: line.rsl, connectingLaneRsl,
      }))),
    };
    movements.set(movement.id, movement);
    add(junctionHeads, movement.junctionId, headIds);
    add(junctionControllers, movement.junctionId, controllerIds);
    add(junctionMovements, movement.junctionId, [movement.id]);
    for (const headId of headIds) {
      add(headsToMovements, headId, [movement.id]);
      add(headsToControllers, headId, controllerIds);
      add(headsToJunctions, headId, [movement.junctionId]);
    }
    const groups = binding.controllerHeadGroups ?? controllerIds.map((controllerId) => ({ controllerId, headIds }));
    for (const group of groups) {
      add(controllerHeads, group.controllerId, group.headIds);
      add(controllerMovements, group.controllerId, [movement.id]);
      controllerJunction.set(group.controllerId, movement.junctionId);
      for (const headId of group.headIds) {
        add(headsToControllers, headId, [group.controllerId]);
        add(headsToJunctions, headId, [movement.junctionId]);
      }
    }
  }

  const allHeadIds = unique([
    ...catalogHeads.map((head) => typeof head === 'string' ? head : head.id),
    ...headsToMovements.keys(),
    ...headsToControllers.keys(),
  ]);
  const heads = new Map<string, SignalHeadControlBinding>();
  for (const id of allHeadIds) {
    const movementIds = unique(headsToMovements.get(id) ?? []);
    const resolved = movementIds.length > 0;
    heads.set(id, {
      id,
      junctionIds: unique(headsToJunctions.get(id) ?? []),
      controllerIds: unique(headsToControllers.get(id) ?? []),
      movementIds,
      resolved,
    });
    if (!resolved) diagnostics.push({
      code: 'unresolved_head',
      message: `Physical signal head ${id} has no exact movement/controller binding.`,
      headIds: [id],
    });
    if (movementIds.length > 1) diagnostics.push({
      code: 'shared_head',
      message: `Physical signal head ${id} is shared by ${movementIds.length} movements.`,
      headIds: [id],
      movementIds,
    });
  }

  const controllers = new Map<string, SignalControllerBinding>();
  for (const id of unique(controllerHeads.keys())) {
    controllers.set(id, {
      id,
      junctionId: controllerJunction.get(id) ?? '',
      headIds: unique(controllerHeads.get(id) ?? []),
      movementIds: unique(controllerMovements.get(id) ?? []),
    });
  }
  const junctions = new Map<string, SignalJunctionControlBinding>();
  for (const id of unique(junctionMovements.keys())) {
    junctions.set(id, {
      id,
      controllerIds: unique(junctionControllers.get(id) ?? []),
      movementIds: unique(junctionMovements.get(id) ?? []),
      headIds: unique(junctionHeads.get(id) ?? []),
    });
  }
  return { heads, movements, controllers, junctions, diagnostics, physicalHeadIds };
}

/** Resolve a clicked physical head into a deterministic reference movement and
 * all related highlighting scopes. */
export function selectSignalReference(
  index: SignalControlIndex,
  headId: string,
  preferredMovementId?: string,
  preferredControllerId?: string,
): SignalReferenceSelection | null {
  const head = index.heads.get(headId);
  if (!head?.resolved) return null;
  const referenceMovementId = preferredMovementId && head.movementIds.includes(preferredMovementId)
    ? preferredMovementId
    : head.movementIds[0]!;
  const movement = index.movements.get(referenceMovementId);
  if (!movement) return null;
  const eligibleControllerIds = movement.controllerIds.filter((controllerId) =>
    index.controllers.get(controllerId)?.headIds.includes(headId),
  );
  if (preferredControllerId && !eligibleControllerIds.includes(preferredControllerId)) return null;
  const referenceControllerId = preferredControllerId ?? eligibleControllerIds[0];
  if (!referenceControllerId) return null;
  const controller = index.controllers.get(referenceControllerId);
  if (!controller || controller.junctionId !== movement.junctionId || !controller.headIds.includes(headId)) return null;
  const junction = index.junctions.get(movement.junctionId);
  const relevantCodes = new Set<SignalControlDiagnosticCode>([
    'unresolved_head', 'unresolved_movement', 'shared_head', 'missing_controller_stage',
  ]);
  return {
    selectedHeadId: headId,
    referenceMovementId,
    referenceControllerId,
    junctionId: movement.junctionId,
    controllerIds: movement.controllerIds,
    stageMovementIds: controller.movementIds,
    movementHeadIds: controller.headIds,
    intersectionHeadIds: junction?.headIds ?? movement.headIds,
    relatedMovementIds: junction?.movementIds ?? [movement.id],
    diagnostics: index.diagnostics.filter((diagnostic) =>
      relevantCodes.has(diagnostic.code) && (
        diagnostic.headIds?.some((id) => (junction?.headIds ?? movement.headIds).includes(id)) ||
        diagnostic.movementIds?.some((id) => (junction?.movementIds ?? [movement.id]).includes(id))
      )),
  };
}

/** Resolve a simultaneous union of exact controller stages. The primary
 * reference remains the display anchor; no unselected stage is activated. */
export function selectSignalPlanReference(
  index: SignalControlIndex,
  reference: MapSignalPlanClip['reference'],
): SignalReferenceSelection | null {
  const resolve = (stage: { readonly controllerId: string; readonly headId: string }) => {
    const controller = index.controllers.get(stage.controllerId);
    const head = index.heads.get(stage.headId);
    const movementId = controller?.movementIds.find((id) => head?.movementIds.includes(id));
    return movementId
      ? selectSignalReference(index, stage.headId, movementId, stage.controllerId)
      : null;
  };
  const primary = resolve(reference);
  if (!primary) return null;
  const displayHeadIds = unique(reference.displayHeadIds ?? []);
  if (displayHeadIds.some((id) => !index.physicalHeadIds?.has(id))) return null;
  if (!reference.additionalStages?.length && displayHeadIds.length === 0 && reference.movements === undefined) return primary;
  const seen = new Set([reference.controllerId]);
  const movementIds = new Set(primary.stageMovementIds);
  const headIds = new Set(primary.movementHeadIds);
  for (const stage of reference.additionalStages ?? []) {
    if (seen.has(stage.controllerId)) return null;
    seen.add(stage.controllerId);
    const selection = resolve(stage);
    if (!selection || selection.junctionId !== primary.junctionId) return null;
    for (const id of selection.stageMovementIds) movementIds.add(id);
    for (const id of selection.movementHeadIds) headIds.add(id);
  }
  if (reference.movements !== undefined) {
    movementIds.clear();
    for (const id of primary.stageMovementIds) {
      if (index.movements.get(id)?.lanePairs?.length === 0) movementIds.add(id);
    }
    const pairs = new Set<string>();
    for (const pair of reference.movements) {
      const key = JSON.stringify([pair.approachLaneRsl, pair.connectingLaneRsl]);
      if (pairs.has(key)) return null;
      pairs.add(key);
      let found = false;
      for (const id of primary.relatedMovementIds) {
        const movement = index.movements.get(id);
        if (movement?.lanePairs?.some((candidate) =>
          candidate.approachLaneRsl === pair.approachLaneRsl && candidate.connectingLaneRsl === pair.connectingLaneRsl,
        )) {
          movementIds.add(id);
          found = true;
        }
      }
      if (!found) return null;
    }
  }
  return {
    ...primary,
    controllerIds: unique(seen),
    stageMovementIds: unique(movementIds),
    movementHeadIds: unique(headIds),
    displayHeadIds,
    intersectionHeadIds: unique([...primary.intersectionHeadIds, ...displayHeadIds]),
  };
}

/** Project authored movement state onto every physical head at the selected
 * intersection. Exact controller-stage head membership is authoritative;
 * programs that cannot express the resulting per-head state fail closed in
 * the map signal plan compiler. */
export function evaluateSignalReferencePhase(
  index: SignalControlIndex,
  selection: SignalReferenceSelection,
  input: SignalReferenceEvaluationInput,
): SignalReferenceEvaluationResult {
  const diagnostics: SignalControlDiagnostic[] = [...selection.diagnostics];
  const movementStates: Record<string, ControlIndication> = {};
  const siblingPhase: ControlIndication = input.referencePhase === 'flashing_red'
    ? 'flashing_red'
    : input.referencePhase === 'flashing_yellow'
      ? 'flashing_red'
      : 'red';
  const stageMovements = new Set(selection.stageMovementIds);
  for (const movementId of selection.relatedMovementIds) {
    movementStates[movementId] = input.referencePhase === 'red' || input.referencePhase === 'flashing_red'
      ? siblingPhase
      : stageMovements.has(movementId)
        ? input.referencePhase
        : siblingPhase;
    const requested = input.movementPhases?.[movementId];
    if (requested && requested !== movementStates[movementId]) {
      const movement = index.movements.get(movementId);
      diagnostics.push({
        code: 'conflicting_controller_stage',
        message: `Movement ${movementId} requested ${requested} while controller stage ${selection.referenceControllerId} requires ${movementStates[movementId]}; the safe derived state was used.`,
        movementIds: [selection.referenceMovementId, movementId],
        controllerIds: unique(movement?.controllerIds ?? []),
      });
    }
  }

  const headStates: Record<string, ControlIndication> = {};
  const stageHeads = new Set(selection.movementHeadIds);
  for (const headId of selection.intersectionHeadIds) {
    headStates[headId] = input.referencePhase === 'red' || input.referencePhase === 'flashing_red'
      ? siblingPhase
      : stageHeads.has(headId)
        ? input.referencePhase
        : siblingPhase;
  }
  for (const headId of selection.displayHeadIds ?? []) headStates[headId] = input.referencePhase;
  return { timeSeconds: input.timeSeconds, headStates, movementStates, diagnostics };
}
