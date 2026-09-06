/**
 * The signal model's own rules, over a hand-built projection.
 *
 * The companion `signal-control-projection.test.ts` proves the layer agrees with
 * the real compiler on a real map. This one covers the cases a real map does not
 * conveniently contain: a protected-left approach, the 256-clip cap, a stale
 * binding, a hand-painted plan, and a cross-map transfer between junctions of
 * different shape.
 *
 * The projection below is a four-way with a protected left: two stages, and the
 * northbound approach carries a through/right ball head plus a left-only head.
 * That shape is what makes the arrow-lens rule testable — a one-turn approach
 * must NOT produce an arrow, and this map has one of each.
 */

import { describe, expect, it } from 'vitest';

import { MapSignalPlanSchema, type MapSignalPlan } from '@simforge-oss/scenario';
import { selectedHeadHighlight } from '../../../src/scenario/editor/signals/orb-layer';

import {
  buildDefaultMapSignalPlanForHead,
  buildMapSignalPlan,
  checkPlanBinding,
  decompilePlanToCycle,
  layOutCycle,
  mapSignalPlanId,
  MAX_PLAN_CLIPS,
  planForJunction,
  upsertMapSignalPlan,
} from '../../../src/lib/scenario/signals/plan';
import {
  approachBearingRad,
  buildMovementDiagram,
  compassLabel,
  movementTurnGlyph,
} from '../../../src/lib/scenario/signals/movement-diagram';
import { lensKindForHead, signalLensKindIndex } from '../../../src/lib/scenario/signals/lens-kinds';
import {
  clampReferenceTiming,
  compileReferenceCycle,
  crossingStageCount,
  holdCycle,
  readReferenceTiming,
  referenceCycleSeconds,
} from '../../../src/lib/scenario/signals/reference-cycle';
import {
  buildEditorSignalIndex,
  orderedStages,
  selectSignalHead,
  stageConflictWarnings,
  stageIndexOfHead,
  unclaimedHeadIds,
} from '../../../src/lib/scenario/signals/stages';
import {
  baselineIndicationAt,
  buildSignalTimelineRows,
  buildReferenceSignalTimelineRow,
  buildStageTimelineRows,
  editorSignalStatesAt,
  siblingIndication,
  clipBoundaries,
  retimeClipBoundary,
  snapTimelineSeconds,
} from '../../../src/lib/scenario/signals/timeline';
import {
  EDITOR_SIGNAL_PROJECTION_VERSION,
  type EditorSignalControlProjection,
} from '../../../src/lib/scenario/signals/types';
import {
  matchJunctions,
  proposeSignalPlanTransfer,
} from '../../../src/lib/scenario/signals/cross-map-transfer';
import { signalTriggerTargets } from '../../../src/lib/scenario/signals/trigger-targets';

const DIGEST = 'controls-abc';

/**
 * Junction `J1`: two stages.
 *
 * - stage `C1` — northbound through/right (head `NB`) and northbound protected
 *   left (head `NBL`);
 * - stage `C2` — eastbound through only (head `EB`).
 *
 * `NB` and `NBL` share approach `10:0:-1`, which is what makes `NBL` a protected
 * left. `EB` is alone on `20:0:-1`, so it must stay a ball.
 */
function fourWayProjection(overrides: Partial<EditorSignalControlProjection> = {}): EditorSignalControlProjection {
  return {
    schemaVersion: EDITOR_SIGNAL_PROJECTION_VERSION,
    mapVersionId: 'usmv_one',
    mapId: 'map-one',
    controlDigest: DIGEST,
    xodrSha256: 'a'.repeat(64),
    heads: [
      { id: 'EB', roadId: '20', s: 40, dynamic: true, junctionIds: ['J1'], controllerIds: ['C2'], movementIds: ['signal:EB'], resolved: true },
      { id: 'NB', roadId: '10', s: 40, dynamic: true, junctionIds: ['J1'], controllerIds: ['C1'], movementIds: ['signal:NB'], resolved: true },
      { id: 'NBL', roadId: '10', s: 40, dynamic: true, junctionIds: ['J1'], controllerIds: ['C1'], movementIds: ['signal:NBL'], resolved: true },
      // A physical head no controller claims: it must never become authorable.
      { id: 'ORPHAN', roadId: '30', s: 5, dynamic: true, junctionIds: [], controllerIds: [], movementIds: [], resolved: false },
    ],
    controllers: [
      { id: 'C1', sequence: 1, junctionId: 'J1', headIds: ['NB', 'NBL'], movementIds: ['signal:NB', 'signal:NBL'] },
      { id: 'C2', sequence: 2, junctionId: 'J1', headIds: ['EB'], movementIds: ['signal:EB'] },
    ],
    movements: [
      { id: 'signal:EB', junctionId: 'J1', controllerIds: ['C2'], headIds: ['EB'], approachLaneRsls: ['20:0:-1'], connectingLaneRsls: ['21:0:-1'], gateIds: ['g-eb'], turnRelations: ['straight'], label: 'Head EB · straight' },
      { id: 'signal:NB', junctionId: 'J1', controllerIds: ['C1'], headIds: ['NB'], approachLaneRsls: ['10:0:-1'], connectingLaneRsls: ['11:0:-1'], gateIds: ['g-nb'], turnRelations: ['straight'], label: 'Head NB · straight' },
      { id: 'signal:NBL', junctionId: 'J1', controllerIds: ['C1'], headIds: ['NBL'], approachLaneRsls: ['10:0:-1'], connectingLaneRsls: ['12:0:-1'], gateIds: ['g-nbl'], turnRelations: ['left'], label: 'Head NBL · left' },
    ],
    junctions: [
      { junctionId: 'J1', center: { x: 0, z: 0 }, radiusM: 12, controllerIds: ['C1', 'C2'], headIds: ['EB', 'NB', 'NBL'], movementIds: ['signal:EB', 'signal:NB', 'signal:NBL'], signalized: true },
      { junctionId: 'J2', center: { x: 200, z: 0 }, radiusM: 8, controllerIds: [], headIds: [], movementIds: [], signalized: false },
    ],
    baselines: [
      { movementId: 'signal:NB', junctionId: 'J1', headIds: ['NB', 'NBL'], controllerIds: ['C1'], phases: [{ indication: 'green', durationS: 6 }, { indication: 'red', durationS: 6 }], offsetS: 0, loop: true, timingSource: 'synthetic-default' },
      { movementId: 'signal:EB', junctionId: 'J1', headIds: ['EB'], controllerIds: ['C2'], phases: [{ indication: 'red', durationS: 6 }, { indication: 'green', durationS: 6 }], offsetS: 0, loop: true, timingSource: 'synthetic-default' },
    ],
    conflictPairsByJunction: { J1: [{ gateA: 'g-nb', gateB: 'g-eb' }] },
    conflictSource: 'derived-artifact',
    diagnostics: [],
    ...overrides,
  };
}

const index = buildEditorSignalIndex(fourWayProjection());

describe('stage resolution', () => {
  it('resolves a clicked head to one stage and the three highlight tiers', () => {
    const selection = selectSignalHead(index, 'NBL');
    expect(selection).toMatchObject({
      selectedHeadId: 'NBL',
      junctionId: 'J1',
      referenceMovementId: 'signal:NBL',
      referenceControllerId: 'C1',
    });
    // The stage owns both northbound heads, so both show the authored
    // indication; the eastbound head is the rest of the intersection.
    expect(selection!.movementHeadIds).toEqual(['NB', 'NBL']);
    expect(selection!.intersectionHeadIds).toEqual(['EB', 'NB', 'NBL']);
    expect(selectedHeadHighlight(selection)).toEqual({
      selectedHeadId: 'NBL',
      movementHeadIds: [],
      intersectionHeadIds: [],
    });
  });

  it('refuses an unresolved head instead of attributing it geometrically', () => {
    // v1 fell back to a 25 m footprint match here and reported the tier. There is
    // nothing to fall back to when the ids are exact, and inventing an
    // attribution would hide a real map defect.
    expect(selectSignalHead(index, 'ORPHAN')).toBeNull();
    expect(selectSignalHead(index, 'NOT-A-HEAD')).toBeNull();
  });

  it('refuses a stage the clicked head does not belong to', () => {
    // The compiler rejects this as `map_signal_plan_reference_unbound`; catching
    // it at selection means the panel never offers the pairing.
    expect(selectSignalHead(index, 'EB', { controllerId: 'C1' })).toBeNull();
    expect(selectSignalHead(index, 'EB', { controllerId: 'C2' })).not.toBeNull();
  });

  it('orders stages and locates the clicked one', () => {
    expect(orderedStages(index, 'J1').map((stage) => stage.id)).toEqual(['C1', 'C2']);
    expect(stageIndexOfHead(index, 'J1', 'EB')).toBe(1);
    expect(stageIndexOfHead(index, 'J1', 'ORPHAN')).toBe(-1);
    expect(unclaimedHeadIds(index, 'J1')).toEqual([]);
  });

  it('collapses controller aliases that command the same executable movement', () => {
    const base = fourWayProjection();
    const lead = base.controllers.find((controller) => controller.id === 'C1')!;
    const aliased = buildEditorSignalIndex({
      ...base,
      controllers: [
        lead,
        { ...lead, id: 'C1-alias', sequence: 1 },
        { ...base.controllers.find((controller) => controller.id === 'C2')!, sequence: 2 },
      ],
      heads: base.heads.map((head) => head.controllerIds.includes('C1')
        ? { ...head, controllerIds: [...head.controllerIds, 'C1-alias'] }
        : head),
      movements: base.movements.map((movement) => movement.controllerIds.includes('C1')
        ? { ...movement, controllerIds: [...movement.controllerIds, 'C1-alias'] }
        : movement),
      junctions: base.junctions.map((junction) => junction.junctionId === 'J1'
        ? { ...junction, controllerIds: ['C1', 'C1-alias', 'C2'] }
        : junction),
      baselines: base.baselines.map((baseline) => baseline.controllerIds.includes('C1')
        ? { ...baseline, controllerIds: [...baseline.controllerIds, 'C1-alias'] }
        : baseline),
    });
    expect(orderedStages(aliased, 'J1').map((stage) => stage.id)).toEqual(['C1', 'C2']);
    expect(crossingStageCount(aliased, 'J1')).toBe(1);

    const cycle = compileReferenceCycle({
      index: aliased,
      junctionId: 'J1',
      referenceHeadId: 'NBL',
      timing: { greenS: 5, yellowS: 5, redS: 10 },
      phaseOrder: ['green', 'red', 'yellow'],
    });
    expect(cycle.map(({ controllerId, indication, durationS }) => ({
      controllerId,
      indication,
      durationS,
    }))).toEqual([
      { controllerId: 'C1', indication: 'green', durationS: 5 },
      { controllerId: 'C2', indication: 'green', durationS: 5 },
      { controllerId: 'C2', indication: 'yellow', durationS: 5 },
      { controllerId: 'C1', indication: 'yellow', durationS: 5 },
    ]);
    const aliasedPlan = buildMapSignalPlan({
      projection: aliased.projection,
      junctionId: 'J1',
      clips: layOutCycle({ cycle, clipSeconds: 20, coverage: 'clip', junctionId: 'J1' }).clips,
    });
    const states = editorSignalStatesAt({
      index: aliased,
      plans: [aliasedPlan],
      timeS: 6,
      clipSeconds: 20,
      warmupSeconds: 0,
    });
    expect(states).toMatchObject({ NB: 'red', NBL: 'red', EB: 'green' });
    const leadRow = buildStageTimelineRows({
      index: aliased,
      plans: [aliasedPlan],
      clipSeconds: 20,
      warmupSeconds: 0,
      junctionId: 'J1',
    }).find((row) => row.controllerId === 'C1')!;
    expect(leadRow.bands.find((band) => band.startS <= 6 && band.endS > 6)?.indication).toBe('red');
  });

  it('warns when a declared stage runs conflicting gates, and stays silent without data', () => {
    // C1 holds g-nb and g-nbl; the conflict is g-nb vs g-eb, which spans stages,
    // so nothing is wrong and nothing is reported.
    expect(stageConflictWarnings(index, 'J1', 'C1')).toEqual([]);

    const selfConflicting = buildEditorSignalIndex(
      fourWayProjection({ conflictPairsByJunction: { J1: [{ gateA: 'g-nb', gateB: 'g-nbl' }] } }),
    );
    expect(stageConflictWarnings(selfConflicting, 'J1', 'C1')).toHaveLength(1);

    // No conflict data means no warning — never a guessed one.
    const blind = buildEditorSignalIndex(
      fourWayProjection({ conflictSource: 'none', conflictPairsByJunction: {} }),
    );
    expect(stageConflictWarnings(blind, 'J1', 'C1')).toEqual([]);
  });
});

describe('reference cycle', () => {
  it('leads with the clicked light and shares the red window with the other stages', () => {
    expect(crossingStageCount(index, 'J1')).toBe(1);
    const cycle = compileReferenceCycle({
      index,
      junctionId: 'J1',
      referenceHeadId: 'NBL',
      timing: { greenS: 8, yellowS: 2, redS: 10 },
    });
    expect(cycle).toEqual([
      { controllerId: 'C1', headId: 'NBL', indication: 'green', durationS: 8, label: 'Green' },
      { controllerId: 'C1', headId: 'NBL', indication: 'yellow', durationS: 2, label: 'Yellow' },
      { controllerId: 'C2', headId: 'EB', indication: 'green', durationS: 8, label: 'Cross 1' },
      { controllerId: 'C2', headId: 'EB', indication: 'yellow', durationS: 2, label: 'Cross 1 yellow' },
    ]);
    // The lead clips persist the exact clicked head; only crossing stages use
    // deterministic representative heads.
    expect(cycle[0]!.headId).toBe('NBL');
    expect(referenceCycleSeconds({ greenS: 8, yellowS: 2, redS: 10 })).toBe(20);
  });

  it('holds all-red rather than inventing a cross stage when nothing else is declared', () => {
    const single = buildEditorSignalIndex(
      fourWayProjection({
        controllers: [{ id: 'C1', sequence: 1, junctionId: 'J1', headIds: ['NB'], movementIds: ['signal:NB'] }],
        junctions: [{ junctionId: 'J1', center: { x: 0, z: 0 }, radiusM: 12, controllerIds: ['C1'], headIds: ['NB'], movementIds: ['signal:NB'], signalized: true }],
      }),
    );
    const cycle = compileReferenceCycle({
      index: single,
      junctionId: 'J1',
      referenceHeadId: 'NB',
      timing: { greenS: 5, yellowS: 0, redS: 5 },
    });
    // A red-referenced clip holds the WHOLE junction red — that is
    // `evaluateSignalReferencePhase`'s sibling rule — so this is a true all-red
    // hold and not a stage that greens nothing.
    expect(cycle).toEqual([
      { controllerId: 'C1', headId: 'NB', indication: 'green', durationS: 5, label: 'Green' },
      { controllerId: 'C1', headId: 'NB', indication: 'red', durationS: 5, label: 'Red' },
    ]);
  });

  it('clamps a mid-typing value rather than compiling a zero-length clip', () => {
    expect(clampReferenceTiming({ greenS: 0, yellowS: -4, redS: 1e9 })).toEqual({
      greenS: 1,
      yellowS: 0,
      redS: 600,
    });
    // Yellow may legitimately be zero; green and red may not.
    expect(clampReferenceTiming({ greenS: 3, yellowS: 0, redS: 3 })).toEqual({ greenS: 3, yellowS: 0, redS: 3 });
    const cycle = compileReferenceCycle({
      index,
      junctionId: 'J1',
      referenceHeadId: 'NB',
      timing: { greenS: 1, yellowS: Number.NaN, redS: 1 },
    });
    expect(cycle.every((interval) => interval.durationS > 0)).toBe(true);
  });

  it('reports a hand-edited cycle as not generated', () => {
    const generated = compileReferenceCycle({
      index,
      junctionId: 'J1',
      referenceHeadId: 'NB',
      timing: { greenS: 8, yellowS: 2, redS: 10 },
    });
    expect(readReferenceTiming({ index, junctionId: 'J1', referenceHeadId: 'NB', cycle: generated })).toEqual({
      timing: { greenS: 8, yellowS: 2, redS: 10 },
      phaseOrder: ['green', 'yellow', 'red'],
      generated: true,
    });

    // Shortening a CROSS green is still re-derivable: the lead numbers are
    // unchanged and the shorter red window redistributes to exactly the edit. So
    // it correctly stays `generated` — the three numbers do still explain it.
    const shorterCross = [...generated];
    shorterCross[2] = { ...shorterCross[2]!, durationS: 3 };
    expect(readReferenceTiming({ index, junctionId: 'J1', referenceHeadId: 'NB', cycle: shorterCross })).toEqual({
      timing: { greenS: 8, yellowS: 2, redS: 5 },
      phaseOrder: ['green', 'yellow', 'red'],
      generated: true,
    });

    // Changing an indication is not: no timing produces a cross stage that goes
    // straight to red, so the card must offer rather than assume.
    const repainted = [...generated];
    repainted[2] = { ...repainted[2]!, indication: 'red' };
    expect(readReferenceTiming({ index, junctionId: 'J1', referenceHeadId: 'NB', cycle: repainted }).generated).toBe(false);

    // The three table rows can be reordered without turning the cycle into a
    // hand edit; decompilation recovers that order for the next render.
    const reordered = [generated[2]!, generated[3]!, generated[0]!, generated[1]!];
    expect(readReferenceTiming({ index, junctionId: 'J1', referenceHeadId: 'NB', cycle: reordered })).toEqual({
      timing: { greenS: 8, yellowS: 2, redS: 10 },
      phaseOrder: ['red', 'green', 'yellow'],
      generated: true,
    });
    expect(readReferenceTiming({ index, junctionId: 'J1', referenceHeadId: 'NB', cycle: [] }).generated).toBe(false);
  });

  it('builds a single-interval hold', () => {
    expect(holdCycle({ index, junctionId: 'J1', referenceHeadId: 'EB', indication: 'flashing_red', durationS: 20 })).toEqual([
      { controllerId: 'C2', headId: 'EB', indication: 'flashing_red', durationS: 20, label: 'Hold' },
    ]);
    expect(holdCycle({ index, junctionId: 'J1', referenceHeadId: 'EB', indication: 'red', durationS: 0 })).toEqual([]);
  });
});

describe('clip layout', () => {
  const cycle = compileReferenceCycle({
    index,
    junctionId: 'J1',
    referenceHeadId: 'NB',
    timing: { greenS: 3, yellowS: 0, redS: 3 },
  });

  it('lays a repeating cycle out contiguously and truncates the last clip to the duration', () => {
    const layout = layOutCycle({ cycle, clipSeconds: 8, coverage: 'clip', junctionId: 'J1' });
    expect(layout.clips.map((clip) => [clip.startS, clip.endS, clip.indication])).toEqual([
      [0, 3, 'green'],
      [3, 6, 'green'],
      [6, 8, 'green'],
    ]);
    expect(layout.coveredUntilS).toBe(8);
    expect(layout.truncated).toBe(false);
    // The schema is the arbiter of contiguity, so let it judge.
    expect(() =>
      MapSignalPlanSchema.parse(buildMapSignalPlan({ projection: fourWayProjection(), junctionId: 'J1', clips: layout.clips })),
    ).not.toThrow();
  });

  it('leaves the tail to the map baseline under `once`', () => {
    const layout = layOutCycle({ cycle, clipSeconds: 20, coverage: 'once', junctionId: 'J1' });
    expect(layout.clips).toHaveLength(cycle.length);
    expect(layout.coveredUntilS).toBe(6);
    expect(layout.truncated).toBe(false);
  });

  it('reports truncation at the 256-clip cap instead of emitting an invalid plan', () => {
    // A 0.5 s cycle over an hour would want 7,200 clips.
    const fast = compileReferenceCycle({
      index,
      junctionId: 'J1',
      referenceHeadId: 'NB',
      timing: { greenS: 1, yellowS: 0, redS: 1 },
    });
    const layout = layOutCycle({ cycle: fast, clipSeconds: 3600, coverage: 'clip', junctionId: 'J1' });
    expect(layout.clips).toHaveLength(MAX_PLAN_CLIPS);
    expect(layout.truncated).toBe(true);
    expect(layout.coveredUntilS).toBeLessThan(3600);
    // Still a valid plan — a truncated one, which the panel must say.
    expect(() =>
      MapSignalPlanSchema.parse(buildMapSignalPlan({ projection: fourWayProjection(), junctionId: 'J1', clips: layout.clips })),
    ).not.toThrow();
  });

  it('honours a start offset and degenerate inputs', () => {
    expect(layOutCycle({ cycle, clipSeconds: 8, coverage: 'clip', startAtS: 2, junctionId: 'J1' }).clips[0]).toMatchObject({ startS: 2 });
    expect(layOutCycle({ cycle: [], clipSeconds: 8, coverage: 'clip', junctionId: 'J1' }).clips).toEqual([]);
    expect(layOutCycle({ cycle, clipSeconds: 0, coverage: 'clip', junctionId: 'J1' }).clips).toEqual([]);
    // A start at or past the end covers nothing rather than wrapping.
    expect(layOutCycle({ cycle, clipSeconds: 8, coverage: 'clip', startAtS: 8, junctionId: 'J1' }).clips).toEqual([]);
  });
});

describe('plan binding', () => {
  const projection = fourWayProjection();
  const cycle = compileReferenceCycle({
    index,
    junctionId: 'J1',
    referenceHeadId: 'NB',
    timing: { greenS: 4, yellowS: 2, redS: 6 },
  });
  const plan = buildMapSignalPlan({
    projection,
    junctionId: 'J1',
    clips: layOutCycle({ cycle, clipSeconds: 12, coverage: 'clip', junctionId: 'J1' }).clips,
  });

  it('accepts a fresh plan and names the id after its junction', () => {
    expect(plan.id).toBe(mapSignalPlanId('J1'));
    expect(checkPlanBinding(index, plan)).toEqual({ ok: true });
  });

  it('validates exact physical references and treats the digest as provenance', () => {
    expect(checkPlanBinding(index, { ...plan, binding: { ...plan.binding, mapId: 'other-map' } })).toMatchObject({
      ok: false,
      code: 'map_signal_plan_map_mismatch',
    });
    expect(checkPlanBinding(index, {
      ...plan,
      binding: { ...plan.binding, controlDigest: 'historical-provenance' },
    })).toEqual({ ok: true });
    expect(checkPlanBinding(index, { ...plan, binding: { ...plan.binding, junctionId: 'J2' } })).toMatchObject({
      ok: false,
      code: 'map_signal_plan_junction_unbound',
    });
    const misreferenced: MapSignalPlan = {
      ...plan,
      clips: [{ ...plan.clips[0]!, reference: { controllerId: 'C2', headId: 'NB' } }],
    };
    expect(checkPlanBinding(index, misreferenced)).toMatchObject({
      ok: false,
      code: 'map_signal_plan_reference_unbound',
      clipIds: [plan.clips[0]!.id],
    });
  });


  it('keeps one plan per junction and a stable serialisation order', () => {
    const second = buildMapSignalPlan({ projection, junctionId: 'A0', clips: plan.clips });
    const plans = upsertMapSignalPlan(upsertMapSignalPlan([], plan), second);
    expect(plans.map((entry) => entry.binding.junctionId)).toEqual(['A0', 'J1']);
    // Replacing rather than appending is what keeps `compileMapSignalPlans` from
    // silently letting the second plan on a junction win.
    const replaced = upsertMapSignalPlan(plans, { ...plan, clips: [plan.clips[0]!] });
    expect(replaced.filter((entry) => entry.binding.junctionId === 'J1')).toHaveLength(1);
    expect(planForJunction(replaced, 'J1')?.clips).toHaveLength(1);
    expect(planForJunction(replaced, 'nope')).toBeNull();
  });

  it('recovers the cycle from the clips, stopping at the first repetition', () => {
    const recovered = decompilePlanToCycle(index, plan);
    expect(recovered.map((interval) => [interval.controllerId, interval.indication, interval.durationS])).toEqual(
      cycle.map((interval) => [interval.controllerId, interval.indication, interval.durationS]),
    );
    expect(decompilePlanToCycle(index, { ...plan, clips: [] })).toEqual([]);
  });

  it('turns a resolved head click into a full editable default cycle', () => {
    const seeded = buildDefaultMapSignalPlanForHead({
      index,
      headId: 'NB',
      clipSeconds: 20,
    });
    expect(seeded).not.toBeNull();
    expect(seeded!.binding.junctionId).toBe('J1');
    expect(seeded!.clips[0]!.startS).toBe(0);
    expect(seeded!.clips.at(-1)!.endS).toBe(20);

    const row = buildSignalTimelineRows({
      index,
      plans: [seeded!],
      clipSeconds: 20,
      warmupSeconds: 0,
      junctionIds: ['J1'],
    })[0]!;
    expect(row.planned).toBe(true);
    expect(row.bands.length).toBeGreaterThan(1);
    expect(row.bands.every((band) => band.source === 'authored')).toBe(true);

    expect(buildDefaultMapSignalPlanForHead({
      index,
      headId: 'missing',
      clipSeconds: 20,
    })).toBeNull();
  });
});

describe('timeline', () => {
  const projection = fourWayProjection();
  const plan = buildMapSignalPlan({
    projection,
    junctionId: 'J1',
    clips: [
      { id: 'a', startS: 0, endS: 4, reference: { controllerId: 'C1', headId: 'NB' }, indication: 'green' },
      { id: 'b', startS: 4, endS: 6, reference: { controllerId: 'C1', headId: 'NB' }, indication: 'yellow' },
    ],
  });

  it('snaps to the tenth without floating-point residue', () => {
    expect(snapTimelineSeconds(3.34)).toBe(3.3);
    expect(snapTimelineSeconds(3.36)).toBe(3.4);
    // The multiply-then-divide would otherwise yield 3.3000000000000003, and an
    // `endS === next.startS` comparison would stop holding.
    expect(String(snapTimelineSeconds(3.3))).toBe('3.3');
  });

  it('draws authored bands over clips and baseline bands over the gap', () => {
    const rows = buildSignalTimelineRows({ index, plans: [plan], clipSeconds: 12, warmupSeconds: 0 });
    const row = rows.find((candidate) => candidate.junctionId === 'J1')!;
    expect(row.planned).toBe(true);
    expect(row.bands.slice(0, 2)).toEqual([
      { startS: 0, endS: 4, indication: 'green', source: 'authored', clipId: 'a' },
      { startS: 4, endS: 6, indication: 'yellow', source: 'authored', clipId: 'b' },
    ]);
    const afterGap = row.bands.filter((band) => band.startS >= 6);
    expect(afterGap.length).toBeGreaterThan(0);
    expect(afterGap.every((band) => band.source === 'baseline' && band.clipId === null)).toBe(true);
  });

  it('uses the authored clip boundaries for the live 3D signal state', () => {
    const retimedCycle = compileReferenceCycle({
      index,
      junctionId: 'J1',
      referenceHeadId: 'NB',
      timing: { greenS: 6, yellowS: 2, redS: 12 },
    });
    const retimed = buildMapSignalPlan({
      projection,
      junctionId: 'J1',
      clips: layOutCycle({
        cycle: retimedCycle,
        clipSeconds: 20,
        coverage: 'clip',
        junctionId: 'J1',
      }).clips,
    });

    expect(editorSignalStatesAt({
      index,
      plans: [retimed],
      timeS: 5.9,
      clipSeconds: 20,
      warmupSeconds: 0,
    })).toMatchObject({ NB: 'green', NBL: 'green', EB: 'red' });
    expect(editorSignalStatesAt({
      index,
      plans: [retimed],
      timeS: 6,
      clipSeconds: 20,
      warmupSeconds: 0,
    })).toMatchObject({ NB: 'yellow', NBL: 'yellow', EB: 'red' });
  });

  it('projects one junction plan to one canonical physical-light lane', () => {
    const row = buildReferenceSignalTimelineRow({
      index,
      plans: [plan],
      plan,
      clipSeconds: 12,
      warmupSeconds: 0,
    });
    expect(row).toMatchObject({
      junctionId: 'J1',
      controllerId: 'C1',
      referenceHeadId: 'NB',
      headIds: ['NB'],
    });
    expect(buildStageTimelineRows({
      index,
      plans: [plan],
      clipSeconds: 12,
      warmupSeconds: 0,
      junctionId: 'J1',
    })).toHaveLength(2);
  });

  it('keeps a selected physical head red when an overlapping crossing stage turns green', () => {
    const base = fourWayProjection();
    const overlapProjection = {
      ...base,
      heads: base.heads.map((head) => head.id === 'NBL'
        ? { ...head, controllerIds: ['C1', 'C2'] }
        : head),
      controllers: base.controllers.map((controller) => controller.id === 'C2'
        ? {
            ...controller,
            headIds: ['EB', 'NBL'],
            movementIds: ['signal:EB', 'signal:NBL'],
          }
        : controller),
      movements: base.movements.map((movement) => movement.id === 'signal:NBL'
        ? { ...movement, controllerIds: ['C1', 'C2'] }
        : movement),
    };
    const overlapIndex = buildEditorSignalIndex(overlapProjection);
    const overlapPlan = buildMapSignalPlan({
      projection: overlapProjection,
      junctionId: 'J1',
      clips: [
        { id: 'lead-green', startS: 0, endS: 4, reference: { controllerId: 'C1', headId: 'NB' }, indication: 'green' },
        { id: 'lead-yellow', startS: 4, endS: 6, reference: { controllerId: 'C1', headId: 'NB' }, indication: 'yellow' },
        { id: 'cross-green', startS: 6, endS: 12, reference: { controllerId: 'C2', headId: 'EB' }, indication: 'green' },
      ],
    });
    expect(editorSignalStatesAt({
      index: overlapIndex,
      plans: [overlapPlan],
      timeS: 7,
      clipSeconds: 12,
      warmupSeconds: 0,
    })).toMatchObject({ NB: 'red', NBL: 'green', EB: 'green' });
    const row = buildReferenceSignalTimelineRow({
      index: overlapIndex,
      plans: [overlapPlan],
      plan: overlapPlan,
      clipSeconds: 12,
      warmupSeconds: 0,
    });
    expect(row?.bands.map((band) => band.indication)).toEqual(['green', 'yellow', 'red']);
    expect(row?.headIds).toEqual(['NB']);
  });

  it('keeps every stage lane equal to the physical head state at the same time', () => {
    const rows = buildStageTimelineRows({
      index,
      plans: [plan],
      clipSeconds: 12,
      warmupSeconds: 0,
      junctionId: 'J1',
    });
    for (const timeS of [1, 5, 7, 11]) {
      const states = editorSignalStatesAt({
        index,
        plans: [plan],
        timeS,
        clipSeconds: 12,
        warmupSeconds: 0,
      });
      for (const row of rows) {
        const band = row.bands.find((candidate) => timeS >= candidate.startS && timeS < candidate.endS);
        expect(band, `${row.controllerId} must cover ${timeS}s`).toBeDefined();
        for (const headId of row.headIds) {
          expect(states[headId], `${headId} at ${timeS}s`).toBe(band!.indication);
        }
      }
    }
  });

  it('shows the map baseline for an unplanned junction, and nothing for an uncontrolled one', () => {
    const rows = buildSignalTimelineRows({ index, plans: [], clipSeconds: 12, warmupSeconds: 0 });
    expect(rows.map((row) => row.junctionId)).toEqual(['J1']);
    expect(rows[0]!.planned).toBe(false);
    // J2 has no plan and no baseline, so it produces no row at all — an empty row
    // would read as "authored to show nothing".
    expect(rows.some((row) => row.junctionId === 'J2')).toBe(false);
  });

  it('shifts the baseline by warmup, because that is what the compiler does', () => {
    // NB's baseline is green 0-6 then red 6-12 on a 12 s loop. Getting the warmup
    // wrong would put the lane out of step with playback by exactly the warmup,
    // which reads as a plan-timing bug rather than a lane bug.
    const nb = projection.baselines.find((baseline) => baseline.movementId === 'signal:NB')!;
    expect(baselineIndicationAt(nb, 0, 0)).toBe('green');
    expect(baselineIndicationAt(nb, 0, 6)).toBe('red');
    expect(baselineIndicationAt(nb, 0, 12)).toBe('green');
    // Loop, so a warmup past the cycle wraps rather than pinning the last phase.
    expect(baselineIndicationAt(nb, 0, 18)).toBe('red');
    // A program with no phases has no indication to report, rather than 'off'.
    expect(baselineIndicationAt({ ...nb, phases: [] }, 0, 0)).toBeNull();
    // Non-looping programs clamp at both ends instead of wrapping.
    const once = { ...nb, loop: false };
    expect(baselineIndicationAt(once, 0, -5)).toBe('green');
    expect(baselineIndicationAt(once, 99, 0)).toBe('red');
  });

  it('keeps one stage green at every instant of the junction row, whatever the warmup', () => {
    // The row is the junction's DOMINANT indication, and the two stages are
    // complementary, so the junction is letting something through at all times.
    // That is the property the row exists to show, and it must not depend on
    // where the warmup happens to land.
    for (const warmupSeconds of [0, 3, 6, 9]) {
      const row = buildSignalTimelineRows({ index, plans: [], clipSeconds: 12, warmupSeconds })[0]!;
      expect(row.bands.every((band) => band.indication === 'green')).toBe(true);
    }
  });

  it('expands to one row per stage, deriving what the unreferenced stages show', () => {
    const rows = buildStageTimelineRows({ index, plans: [plan], clipSeconds: 12, warmupSeconds: 0, junctionId: 'J1' });
    expect(rows.map((row) => row.controllerId)).toEqual(['C1', 'C2']);

    // C1 is the referenced stage, so it shows the authored indications and its
    // bands carry the clip ids a drag can grab.
    const c1 = rows[0]!;
    expect(c1.bands.slice(0, 2)).toEqual([
      { startS: 0, endS: 4, indication: 'green', source: 'authored', clipId: 'a' },
      { startS: 4, endS: 6, indication: 'yellow', source: 'authored', clipId: 'b' },
    ]);

    // C2 is not referenced, so it holds the derived safe state for the whole
    // covered span — and carries NO clip id, because there is nothing there for a
    // drag to grab.
    const c2 = rows[1]!;
    const covered = c2.bands.filter((band) => band.startS < 6);
    expect(covered.every((band) => band.indication === 'red' && band.source === 'authored')).toBe(true);
    expect(covered.every((band) => band.clipId === null)).toBe(true);
    // Past the clips both stages fall back to their own baseline.
    expect(c2.bands.some((band) => band.startS >= 6 && band.source === 'baseline')).toBe(true);
  });

  it('derives the sibling state by the compiler\'s own rule', () => {
    // A red reference holds the WHOLE junction red — an all-red clearance.
    expect(siblingIndication('red')).toBe('red');
    expect(siblingIndication('green')).toBe('red');
    expect(siblingIndication('yellow')).toBe('red');
    // Flashing yellow on the main street puts the side street on flashing red,
    // which is what a real dark-mode intersection does.
    expect(siblingIndication('flashing_yellow')).toBe('flashing_red');
    expect(siblingIndication('flashing_red')).toBe('flashing_red');

    const flashing = buildMapSignalPlan({
      projection,
      junctionId: 'J1',
      clips: [{ id: 'f', startS: 0, endS: 12, reference: { controllerId: 'C1', headId: 'NB' }, indication: 'flashing_yellow' }],
    });
    const rows = buildStageTimelineRows({ index, plans: [flashing], clipSeconds: 12, warmupSeconds: 0, junctionId: 'J1' });
    expect(rows[0]!.bands.map((band) => band.indication)).toEqual(['flashing_yellow']);
    expect(rows[1]!.bands.map((band) => band.indication)).toEqual(['flashing_red']);
  });

  it('shows pure baseline per stage when no plan governs the junction', () => {
    const rows = buildStageTimelineRows({ index, plans: [], clipSeconds: 12, warmupSeconds: 0, junctionId: 'J1' });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.bands.every((band) => band.source === 'baseline'))).toBe(true);
    // The two stages are complementary, so exactly one is green at any instant.
    expect(rows[0]!.bands[0]!.indication).not.toBe(rows[1]!.bands[0]!.indication);
    expect(buildStageTimelineRows({ index, plans: [], clipSeconds: 12, warmupSeconds: 0, junctionId: 'J2' })).toEqual([]);
  });

  it('retimes a boundary by moving both neighbours, and refuses to collapse a clip', () => {
    const moved = retimeClipBoundary(plan.clips, 4, 5);
    expect(moved.map((clip) => [clip.startS, clip.endS])).toEqual([[0, 5], [5, 6]]);
    expect(clipBoundaries(moved)).toEqual([5]);

    // 5.9 would leave clip `b` at 0.1 s, below the minimum band; the drag is
    // refused whole rather than silently clamped to somewhere the pointer is not.
    expect(retimeClipBoundary(plan.clips, 4, 5.9)).toBe(plan.clips);
    expect(retimeClipBoundary(plan.clips, 4, 0.1)).toBe(plan.clips);
    expect(retimeClipBoundary(plan.clips, 99, 5)).toBe(plan.clips);
  });
});

describe('arrow lenses', () => {
  it('gives an arrow only to a single-turn head on a multi-turn approach', () => {
    const lenses = signalLensKindIndex(index);
    // NBL serves only `left` and shares its approach with a through head.
    expect(lenses.get('NBL')).toBe('left');
    // NB serves `straight`, so it is a ball whatever else is on the approach.
    expect(lenses.has('NB')).toBe(false);
    // EB is alone on its approach: one turn across the whole approach is not a
    // protected turn, it is an approach with one movement.
    expect(lenses.has('EB')).toBe(false);
    expect(lensKindForHead(lenses, 'NBL')).toBe('left');
    expect(lensKindForHead(lenses, 'EB')).toBe('ball');
  });

  it('never reads the arrow from the signal type', () => {
    // A head whose only movement carries an unrecognised relation draws the
    // default housing rather than a guessed glyph.
    const odd = buildEditorSignalIndex(
      fourWayProjection({
        movements: [
          { id: 'signal:NB', junctionId: 'J1', controllerIds: ['C1'], headIds: ['NB'], approachLaneRsls: ['10:0:-1'], connectingLaneRsls: ['11:0:-1'], gateIds: ['g-nb'], turnRelations: ['merge'], label: 'x' },
          { id: 'signal:NBL', junctionId: 'J1', controllerIds: ['C1'], headIds: ['NBL'], approachLaneRsls: ['10:0:-1'], connectingLaneRsls: ['12:0:-1'], gateIds: ['g-nbl'], turnRelations: ['uturn'], label: 'y' },
        ],
      }),
    );
    const lenses = signalLensKindIndex(odd);
    expect(lenses.has('NB')).toBe(false);
    // U-turn resolves to a left arrow: the closest true glyph.
    expect(lenses.get('NBL')).toBe('left');
  });

  it('scopes to the junctions asked for', () => {
    expect(signalLensKindIndex(index, ['J2']).size).toBe(0);
  });
});

describe('movement diagram geometry', () => {
  it('measures the bearing at the junction-facing end, not over the whole lane', () => {
    // A lane that runs east for 100 m then hooks hard north for its last 2 m.
    // Averaging the polyline would point it east; the driver faces north.
    const polyline = [
      { x: -100, y: 0 },
      { x: -20, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(approachBearingRad(polyline, 'end')).toBeCloseTo(Math.PI / 2, 6);
    // Reversed storage order gives the opposite tangent, which is why the caller
    // supplies which end faces the junction rather than this function assuming.
    expect(approachBearingRad([...polyline].reverse(), 'start')).toBeCloseTo(Math.PI / 2, 6);
    expect(approachBearingRad([{ x: 1, y: 1 }], 'end')).toBeNull();
    expect(approachBearingRad([{ x: 1, y: 1 }, { x: 1, y: 1 }], 'end')).toBeNull();
  });

  it('labels an approach by the direction traffic travels, on eight points', () => {
    expect(compassLabel(0)).toBe('Eastbound');
    expect(compassLabel(Math.PI / 2)).toBe('Northbound');
    expect(compassLabel(Math.PI)).toBe('Westbound');
    // Eight points, so two approaches on a skewed junction do not collapse into
    // one label.
    expect(compassLabel(Math.PI / 4)).toBe('Northeastbound');
    expect(compassLabel(-Math.PI / 4)).toBe('Southeastbound');
  });

  it('picks a glyph per movement, and admits when it cannot', () => {
    expect(movementTurnGlyph(index.movementById.get('signal:NBL')!)).toBe('left');
    expect(movementTurnGlyph(index.movementById.get('signal:NB')!)).toBe('straight');
    // A ball lens serving through AND right is a through movement.
    expect(movementTurnGlyph({ ...index.movementById.get('signal:NB')!, turnRelations: ['straight', 'right'] })).toBe('straight');
    // A mixed non-through set is not guessed.
    expect(movementTurnGlyph({ ...index.movementById.get('signal:NB')!, turnRelations: ['left', 'right'] })).toBe('unknown');
    expect(movementTurnGlyph({ ...index.movementById.get('signal:NB')!, turnRelations: [] })).toBe('unknown');
  });

  it('lays arrows out in the diagram frame and drops unmeasurable approaches', () => {
    const arrows = buildMovementDiagram({
      index,
      junctionId: 'J1',
      approaches: new Map([
        // Northbound: travels north (+y local), so the tail is at local -y, which
        // is +y DOWN in the SVG frame.
        ['10:0:-1', { polyline: [{ x: 0, y: -40 }, { x: 0, y: 0 }], towardsJunction: 'end' as const }],
        // 20:0:-1 is deliberately absent: an arrow at a fabricated bearing points
        // an author at the wrong approach.
      ]),
    });
    expect(arrows.map((arrow) => arrow.movementId)).toEqual(['signal:NB', 'signal:NBL']);
    expect(arrows.every((arrow) => arrow.approachLaneRsl === '10:0:-1')).toBe(true);
    const [nb] = arrows;
    expect(nb!.approachBearingRad).toBeCloseTo(Math.PI / 2, 6);
    expect(nb!.tail.x).toBeCloseTo(0, 6);
    expect(nb!.tail.y).toBeCloseTo(1, 6);
    expect(buildMovementDiagram({ index, junctionId: 'nope', approaches: new Map() })).toEqual([]);
  });
});

describe('cross-map transfer', () => {
  /** A target map whose J1 has three stages instead of two. */
  const targetProjection = fourWayProjection({
    mapVersionId: 'usmv_two',
    mapId: 'map-two',
    controlDigest: 'controls-two',
    heads: [
      { id: 'T1', roadId: '1', s: 1, dynamic: true, junctionIds: ['K9'], controllerIds: ['D1'], movementIds: ['signal:T1'], resolved: true },
      { id: 'T2', roadId: '2', s: 1, dynamic: true, junctionIds: ['K9'], controllerIds: ['D2'], movementIds: ['signal:T2'], resolved: true },
      { id: 'T3', roadId: '3', s: 1, dynamic: true, junctionIds: ['K9'], controllerIds: ['D3'], movementIds: ['signal:T3'], resolved: true },
    ],
    controllers: [
      { id: 'D1', sequence: 1, junctionId: 'K9', headIds: ['T1'], movementIds: ['signal:T1'] },
      { id: 'D2', sequence: 2, junctionId: 'K9', headIds: ['T2'], movementIds: ['signal:T2'] },
      { id: 'D3', sequence: 3, junctionId: 'K9', headIds: ['T3'], movementIds: ['signal:T3'] },
    ],
    movements: [
      { id: 'signal:T1', junctionId: 'K9', controllerIds: ['D1'], headIds: ['T1'], approachLaneRsls: ['1:0:-1'], connectingLaneRsls: ['4:0:-1'], gateIds: ['h1'], turnRelations: ['straight'], label: 'T1' },
      { id: 'signal:T2', junctionId: 'K9', controllerIds: ['D2'], headIds: ['T2'], approachLaneRsls: ['2:0:-1'], connectingLaneRsls: ['5:0:-1'], gateIds: ['h2'], turnRelations: ['straight'], label: 'T2' },
      { id: 'signal:T3', junctionId: 'K9', controllerIds: ['D3'], headIds: ['T3'], approachLaneRsls: ['3:0:-1'], connectingLaneRsls: ['6:0:-1'], gateIds: ['h3'], turnRelations: ['left'], label: 'T3' },
    ],
    junctions: [
      { junctionId: 'K9', center: { x: 0, z: 0 }, radiusM: 10, controllerIds: ['D1', 'D2', 'D3'], headIds: ['T1', 'T2', 'T3'], movementIds: ['signal:T1', 'signal:T2', 'signal:T3'], signalized: true },
    ],
    baselines: [],
    conflictPairsByJunction: {},
    conflictSource: 'none',
  });
  const target = buildEditorSignalIndex(targetProjection);
  const sourcePlan = buildMapSignalPlan({
    projection: fourWayProjection(),
    junctionId: 'J1',
    clips: layOutCycle({
      cycle: compileReferenceCycle({ index, junctionId: 'J1', referenceHeadId: 'NB', timing: { greenS: 8, yellowS: 2, redS: 10 } }),
      clipSeconds: 20,
      coverage: 'once',
      junctionId: 'J1',
    }).clips,
  });

  it('ranks candidates and never silently chooses a wrong junction', () => {
    const candidates = matchJunctions({ source: index, target, sourceJunctionId: 'J1' });
    // Different stage count and different signature, so only the weakest basis
    // could apply — and it does not, because the counts differ too.
    expect(candidates).toEqual([]);
  });

  it('carries the timing and reports that the red window is now split differently', () => {
    const proposal = proposeSignalPlanTransfer({
      source: index,
      target,
      sourcePlan,
      targetJunctionId: 'K9',
      clipSeconds: 20,
      coverage: 'once',
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    // The author's three numbers survive; the controller ids do not travel.
    expect(proposal.timing).toEqual({ greenS: 8, yellowS: 2, redS: 10 });
    expect(proposal.plan.binding).toEqual({
      mapId: 'map-two',
      junctionId: 'K9',
      controlDigest: 'controls-two',
    });
    expect(proposal.referenceHeadId).toBe('T1');
    expect(proposal.plan.clips.every((clip) => clip.reference.controllerId.startsWith('D'))).toBe(true);
    // Two crossing stages now share the 10 s red instead of one, so individual
    // cross greens changed length. Said out loud rather than presented as a
    // faithful transfer.
    expect(proposal.stageCountChanged).toBe(true);
    expect(checkPlanBinding(target, proposal.plan)).toEqual({ ok: true });
  });

  it('refuses rather than approximating when there is nothing to carry', () => {
    expect(
      proposeSignalPlanTransfer({ source: index, target, sourcePlan: null, targetJunctionId: 'K9', clipSeconds: 20, coverage: 'once' }),
    ).toMatchObject({ ok: false, reason: 'no_source_plan' });

    // Hand-painted: the clips do not rebuild from any three numbers, so there is
    // no timing to transfer. v1's rule, kept — an unenforceable plan is worse
    // than a refused one.
    const painted: MapSignalPlan = {
      ...sourcePlan,
      clips: [
        { id: 'p1', startS: 0, endS: 1.3, reference: { controllerId: 'C1', headId: 'NB' }, indication: 'green' },
        { id: 'p2', startS: 1.3, endS: 9.1, reference: { controllerId: 'C2', headId: 'EB' }, indication: 'yellow' },
      ],
    };
    expect(
      proposeSignalPlanTransfer({ source: index, target, sourcePlan: painted, targetJunctionId: 'K9', clipSeconds: 20, coverage: 'once' }),
    ).toMatchObject({ ok: false, reason: 'hand_painted' });

    expect(
      proposeSignalPlanTransfer({ source: index, target: index, sourcePlan, targetJunctionId: 'J2', clipSeconds: 20, coverage: 'once' }),
    ).toMatchObject({ ok: false, reason: 'target_unsignalized' });

    const empty = buildEditorSignalIndex(
      fourWayProjection({ heads: [], controllers: [], movements: [], junctions: [], baselines: [] }),
    );
    expect(
      proposeSignalPlanTransfer({ source: index, target: empty, sourcePlan, targetJunctionId: null, clipSeconds: 20, coverage: 'once' }),
    ).toMatchObject({ ok: false, reason: 'no_target_junction' });
  });

  it('matches the same junction id across a rebuild of the same map', () => {
    const rebuilt = buildEditorSignalIndex(fourWayProjection({ controlDigest: 'controls-rebuilt' }));
    const [best] = matchJunctions({ source: index, target: rebuilt, sourceJunctionId: 'J1' });
    expect(best).toMatchObject({ targetJunctionId: 'J1', basis: 'same_junction_id', score: 1 });
  });
});

describe('trigger targets', () => {
  it('offers every signalized junction whether or not a plan exists for it', () => {
    // v1's rule, kept: a junction runs the map's baseline when unplanned, so
    // "when this light goes green" is well defined without a plan. Requiring one
    // would make an author author timing in order to reference timing.
    const targets = signalTriggerTargets(index);
    expect(targets.map((target) => target.junction_id)).toEqual(['J1']);
    // J2 is unsignalized: there is no state to wait for.
    expect(targets.some((target) => target.junction_id === 'J2')).toBe(false);
  });

  it('reports stages, not movements, because a stage is what holds one indication', () => {
    const [target] = signalTriggerTargets(index);
    expect(target!.movements.map((entry) => entry.movement_id)).toEqual(['C1', 'C2']);
    // Labels carry the turns and the heads, which is what distinguishes two
    // stages in a dropdown.
    expect(target!.movements[0]!.label).toContain('C1');
    expect(target!.movements[0]!.label).toContain('NB');
    expect(target!.label).toContain('3 heads');
    expect(target!.label).toContain('2 stages');
  });

  it('keeps v1\'s snake_case wire shape so porting the picker is a store swap', () => {
    const [target] = signalTriggerTargets(index);
    expect(Object.keys(target!).sort()).toEqual(['junction_id', 'label', 'movements']);
    expect(Object.keys(target!.movements[0]!).sort()).toEqual(['label', 'movement_id']);
  });

  it('excludes a junction whose stages command no head', () => {
    const headless = buildEditorSignalIndex(
      fourWayProjection({
        controllers: [{ id: 'C1', sequence: 1, junctionId: 'J1', headIds: [], movementIds: ['signal:NB'] }],
      }),
    );
    expect(signalTriggerTargets(headless)).toEqual([]);
  });
});
