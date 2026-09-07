import { describe, expect, it } from 'vitest';
import { SignalBook, contentHash, routePointsHash, type SignalProgram } from '@simforge-oss/engine';
import type { MapSignalPlan } from '@simforge-oss/scenario';

import { compileMapSignalPlans, MapSignalPlanCompileError } from './map-signal-plan-compiler.js';

const programs: SignalProgram[] = [
  {
    id: 'signal:h1', phases: [{ phase: 'green', durationS: 2 }, { phase: 'red', durationS: 2 }],
    offsetS: 0, loop: true,
    stopLines: [{ rsl: 'a', s: 9, connectingLaneRsls: ['ja'] }],
    mapBinding: { junctionId: 'j1', controllerIds: ['c1'], headIds: ['h1'], controllerHeadGroups: [{ controllerId: 'c1', headIds: ['h1'] }], timingSource: 'synthetic-default' },
  },
  {
    id: 'signal:h2', phases: [{ phase: 'red', durationS: 2 }, { phase: 'green', durationS: 2 }],
    offsetS: 0, loop: true,
    stopLines: [{ rsl: 'b', s: 9, connectingLaneRsls: ['jb'] }],
    mapBinding: { junctionId: 'j1', controllerIds: ['c2'], headIds: ['h2'], controllerHeadGroups: [{ controllerId: 'c2', headIds: ['h2'] }], timingSource: 'synthetic-default' },
  },
];
const catalog = {
  heads: [{ id: 'h1', roadId: '1', s: 1, dynamic: true }, { id: 'h2', roadId: '2', s: 1, dynamic: true }],
  roadControls: [], speedLimits: [], applicability: [],
  controllers: [{ id: 'c1', sequence: 0, signalIds: ['h1'] }, { id: 'c2', sequence: 1, signalIds: ['h2'] }],
  junctions: [{ junctionId: 'j1', controllerIds: ['c1', 'c2'] }],
} as const;
const controls = { signalPrograms: programs, roadControls: [] };
const digest = contentHash(controls);
const plan: MapSignalPlan = {
  id: 'j1-plan', version: 1,
  binding: { mapId: 'map', junctionId: 'j1', controlDigest: digest },
  clips: [{ id: 'clip', startS: 3, endS: 5, reference: { controllerId: 'c1', headId: 'h1' }, indication: 'yellow' }],
};
const options = {
  mapId: 'map', clipSeconds: 8, warmupSeconds: 2,
  signalCatalog: catalog,
};

describe('map signal plan compiler', () => {
  it('selects one exact movement from a merged controller without releasing its other turn', () => {
    const merged = [
      { ...programs[0]!, stopLines: [{ rsl: 'a', s: 9, connectingLaneRsls: ['ja', 'jc'] }] },
      programs[1]!,
    ];
    const authored = {
      ...plan,
      clips: [{ ...plan.clips[0]!, indication: 'green' as const, reference: {
        ...plan.clips[0]!.reference, movements: [{ approachLaneRsl: 'a', connectingLaneRsl: 'ja' }],
      } }],
    };
    const compiled = compileMapSignalPlans(merged, [authored], options);
    const book = new SignalBook(compiled, 2);
    const phasesFor = (connector: string, time: number) => compiled
      .filter(program => program.stopLines.some(line => line.rsl === 'a' && line.connectingLaneRsls.includes(connector)))
      .map(program => book.phaseAt(program.id, time));
    expect(phasesFor('ja', 4)).toEqual(['green']);
    expect(phasesFor('jc', 4)).toEqual(['red']);
    expect(phasesFor('ja', -1)).toEqual(['green']);
    expect(phasesFor('jc', -1)).toEqual(['green']);
    expect(book.phaseAt('signal:h1', 4)).toBe('green');
  });

  it('retimes preserved route signals with their clips while leaving unrelated baselines unchanged', () => {
    const pointsHash = routePointsHash([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const routeSignal = {
      id: 'retained-route', actorId: 'ego', routePointsHash: pointsHash, s: 40,
      selectedByClipIds: ['clip'], phases: [{ phase: 'red' as const, durationS: 120 }], offsetS: 0, loop: true,
    };
    const authored: MapSignalPlan = {
      ...plan,
      routeSignals: [
        routeSignal,
        { ...routeSignal, id: 'other-junction', baselineOnly: true, selectedByClipIds: [], coordinationId: 'j2', phases: [{ phase: 'green', durationS: 120 }] },
      ],
    };
    const withRoutes = { ...options, worldRoutes: { ego: { pointsHash, lengthM: 100 } } };
    const before = new SignalBook(compileMapSignalPlans(programs, [authored], withRoutes), 2);
    expect(before.phaseAt(routeSignal.id, -1)).toBe('red');
    expect(before.phaseAt(routeSignal.id, 4)).toBe('yellow');
    expect(before.phaseAt('other-junction', 4)).toBe('green');
    const retimed = { ...authored, clips: [{ ...authored.clips[0]!, startS: 6, endS: 7, indication: 'green' as const }] };
    const after = new SignalBook(compileMapSignalPlans(programs, [retimed], withRoutes), 2);
    expect(after.phaseAt(routeSignal.id, 4)).toBe('red');
    expect(after.phaseAt(routeSignal.id, 6.5)).toBe('green');
    expect(after.phaseAt(routeSignal.id, 7)).toBe('red');
    expect(after.phaseAt('other-junction', 6.5)).toBe('green');
  });

  it('supports route-only source controls but rejects stale geometry and out-of-route stops', () => {
    const pointsHash = routePointsHash([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    const authored: MapSignalPlan = {
      id: 'source-route-controls', version: 1, binding: { mapId: 'map', junctionId: 'source-junction', controlDigest: contentHash({ signalPrograms: [], roadControls: [] }) }, clips: [],
      routeSignals: [{
        id: 'route-baseline', actorId: 'ego', routePointsHash: pointsHash, s: 40,
        selectedByClipIds: [], baselineOnly: true, phases: [{ phase: 'red', durationS: 120 }], offsetS: 0, loop: true,
      }],
    };
    const withRoutes = { ...options, worldRoutes: { ego: { pointsHash, lengthM: 100 } } };
    const book = new SignalBook(compileMapSignalPlans([], [authored], withRoutes), 2);
    expect(book.phaseAt('route-baseline', 4)).toBe('red');
    expect(() => compileMapSignalPlans([], [authored], { ...withRoutes, worldRoutes: { ego: { pointsHash: '0'.repeat(64), lengthM: 100 } } })).toThrow(MapSignalPlanCompileError);
    expect(() => compileMapSignalPlans([], [authored], { ...withRoutes, worldRoutes: { ego: { pointsHash, lengthM: 30 } } })).toThrow(MapSignalPlanCompileError);
  });

  it('preserves baseline warm-up/gaps and atomically holds other stages red', () => {
    const compiled = compileMapSignalPlans(programs, [plan], options);
    const book = new SignalBook(compiled, 2);
    expect(book.phaseAt('signal:h1', -1)).toBe('green');
    expect(book.phaseAt('signal:h1', 2.5)).toBe('green');
    expect(book.phaseAt('signal:h1', 3)).toBe('yellow');
    expect(book.phaseAt('signal:h2', 4.999)).toBe('red');
    expect(book.phaseAt('signal:h1', 5)).toBe('red');
    expect(book.phaseAt('signal:h1', 8)).toBe('red');
    expect(compiled.every((program) => !program.loop && program.mapBinding?.timingSource === 'authored')).toBe(true);
  });

  it('executes a union of controller stages without forcing a selected stage red', () => {
    const authored = {
      ...plan,
      clips: [{ ...plan.clips[0]!, indication: 'green' as const, reference: {
        controllerId: 'c1', headId: 'h1', additionalStages: [{ controllerId: 'c2', headId: 'h2' }],
      } }],
    };
    const book = new SignalBook(compileMapSignalPlans(programs, [authored], options), 2);
    expect(book.phaseAt('signal:h1', 4)).toBe('green');
    expect(book.phaseAt('signal:h2', 4)).toBe('green');
    expect(book.phaseAt('signal:h1', 5)).toBe('red');
  });

  it('preserves a detached physical lamp baseline and clip without changing movement control', () => {
    const authored: MapSignalPlan = {
      ...plan,
      displayBaselines: [{ headId: 'housing', phases: [{ phase: 'green', durationS: 2 }, { phase: 'red', durationS: 2 }], offsetS: 0, loop: true }],
      clips: [{ ...plan.clips[0]!, reference: { ...plan.clips[0]!.reference, displayHeadIds: ['housing'] } }],
    };
    const compiled = compileMapSignalPlans(programs, [authored], {
      ...options, signalCatalog: { ...catalog, heads: [...catalog.heads, { id: 'housing', kind: 'physical', roadId: '17', s: 1, dynamic: true }] },
    });
    const display = compiled.find(program => program.mapBinding?.headIds.includes('housing'))!;
    expect(display.stopLines).toEqual([]);
    const book = new SignalBook(compiled, 2);
    expect(book.phaseAt(display.id, -1)).toBe('green');
    expect(book.phaseAt(display.id, 4)).toBe('yellow');
    expect(book.phaseAt(display.id, 5)).toBe('red');
    expect(book.phaseAt('signal:h2', 4)).toBe('red');
  });

  it.each(['green', 'yellow', 'red', 'flashing_yellow', 'flashing_red', 'off'] as const)(
    'executes the %s indication for the exact half-open interval',
    (indication) => {
      const authored = { ...plan, clips: [{ ...plan.clips[0]!, indication }] };
      const book = new SignalBook(compileMapSignalPlans(programs, [authored], options), 2);
      expect(book.phaseAt('signal:h1', 2.999999)).toBe('green');
      expect(book.phaseAt('signal:h1', 3)).toBe(indication);
      expect(book.phaseAt('signal:h1', 4.999999)).toBe(indication);
      expect(book.phaseAt('signal:h1', 5)).toBe('red');
      expect(book.phaseAt('signal:h2', 4)).toBe(
        indication === 'flashing_yellow' || indication === 'flashing_red'
          ? 'flashing_red'
          : 'red',
      );
    },
  );

  it.each([
    ['green', 'green', 'red'],
    ['yellow', 'yellow', 'red'],
    ['red', 'red', 'red'],
    ['off', 'off', 'red'],
    ['flashing_yellow', 'flashing_yellow', 'flashing_red'],
    ['flashing_red', 'flashing_red', 'flashing_red'],
  ] as const)(
    'closes exact multi-movement controller stages for %s',
    (indication, expectedStage, expectedConflict) => {
      const sameStage: SignalProgram = {
        id: 'signal:h3', phases: [{ phase: 'red', durationS: 4 }], offsetS: 0, loop: true,
        stopLines: [{ rsl: 'c', s: 9, connectingLaneRsls: ['jc'] }],
        mapBinding: {
          junctionId: 'j1', controllerIds: ['c1'], headIds: ['h3'],
          controllerHeadGroups: [{ controllerId: 'c1', headIds: ['h3'] }],
          timingSource: 'synthetic-default',
        },
      };
      const stagePrograms = [...programs, sameStage];
      const stageCatalog = {
        ...catalog,
        heads: [...catalog.heads, { id: 'h3', roadId: '3', s: 1, dynamic: true }],
        controllers: [
          { id: 'c1', sequence: 0, signalIds: ['h1', 'h3'] },
          catalog.controllers[1]!,
        ],
      };
      const stageDigest = contentHash({ signalPrograms: stagePrograms, roadControls: [] });
      const authored = {
        ...plan,
        binding: { ...plan.binding, controlDigest: stageDigest },
        clips: [{ ...plan.clips[0]!, indication }],
      };
      const compiled = compileMapSignalPlans(stagePrograms, [authored], {
        ...options,
        signalCatalog: stageCatalog,
      });
      const book = new SignalBook(compiled, 2);
      expect(book.phaseAt('signal:h1', 4)).toBe(expectedStage);
      expect(book.phaseAt('signal:h3', 4)).toBe(expectedStage);
      expect(book.phaseAt('signal:h2', 4)).toBe(expectedConflict);
    },
  );

  it('compiles the exact non-first controller selected for a shared physical head', () => {
    const sharedPrograms: SignalProgram[] = [
      {
        id: 'shared-first', phases: [{ phase: 'red', durationS: 4 }], offsetS: 0, loop: true,
        stopLines: [{ rsl: 'a', s: 9, connectingLaneRsls: ['ja'] }],
        mapBinding: { junctionId: 'j1', controllerIds: ['c-first'], headIds: ['shared'], controllerHeadGroups: [{ controllerId: 'c-first', headIds: ['shared'] }], timingSource: 'authored' },
      },
      {
        id: 'shared-preferred', phases: [{ phase: 'red', durationS: 4 }], offsetS: 0, loop: true,
        stopLines: [{ rsl: 'b', s: 9, connectingLaneRsls: ['jb'] }],
        mapBinding: { junctionId: 'j1', controllerIds: ['c-preferred'], headIds: ['preferred-only', 'shared'], controllerHeadGroups: [{ controllerId: 'c-preferred', headIds: ['preferred-only', 'shared'] }], timingSource: 'authored' },
      },
      {
        id: 'conflict', phases: [{ phase: 'green', durationS: 4 }], offsetS: 0, loop: true,
        stopLines: [{ rsl: 'c', s: 9, connectingLaneRsls: ['jc'] }],
        mapBinding: { junctionId: 'j1', controllerIds: ['c-conflict'], headIds: ['conflict'], controllerHeadGroups: [{ controllerId: 'c-conflict', headIds: ['conflict'] }], timingSource: 'authored' },
      },
    ];
    const sharedCatalog = {
      heads: [
        { id: 'shared', roadId: '1', s: 1, dynamic: true },
        { id: 'preferred-only', roadId: '2', s: 1, dynamic: true },
        { id: 'conflict', roadId: '3', s: 1, dynamic: true },
      ],
      roadControls: [], speedLimits: [], applicability: [],
      controllers: [
        { id: 'c-first', sequence: 0, signalIds: ['shared'] },
        { id: 'c-preferred', sequence: 1, signalIds: ['preferred-only', 'shared'] },
        { id: 'c-conflict', sequence: 2, signalIds: ['conflict'] },
      ],
      junctions: [{ junctionId: 'j1', controllerIds: ['c-first', 'c-preferred', 'c-conflict'] }],
    } as const;
    const sharedDigest = contentHash({ signalPrograms: sharedPrograms, roadControls: [] });
    const sharedPlan: MapSignalPlan = {
      ...plan,
      binding: { ...plan.binding, controlDigest: sharedDigest },
      clips: [{ ...plan.clips[0]!, reference: { controllerId: 'c-preferred', headId: 'shared' }, indication: 'green' }],
    };
    const compiled = compileMapSignalPlans(sharedPrograms, [sharedPlan], {
      ...options,
      signalCatalog: sharedCatalog,
    });
    const book = new SignalBook(compiled, 2);
    expect(book.phaseAt('shared-preferred', 4)).toBe('green');
    expect(book.phaseAt('conflict', 4)).toBe('red');
  });

  it('switches adjacent clips exactly at their shared boundary and coalesces equal phases', () => {
    const adjacent: MapSignalPlan = {
      ...plan,
      clips: [
        { ...plan.clips[0]!, indication: 'green' },
        { ...plan.clips[0]!, id: 'next', startS: 5, endS: 6, indication: 'yellow' },
      ],
    };
    const compiled = compileMapSignalPlans(programs, [adjacent], options);
    const book = new SignalBook(compiled, 2);
    expect(book.phaseAt('signal:h1', 4.999999)).toBe('green');
    expect(book.phaseAt('signal:h1', 5)).toBe('yellow');
    expect(compiled.every((program) => program.phases.every((phase, index) =>
      index === 0 || program.phases[index - 1]!.phase !== phase.phase,
    ))).toBe(true);
  });

  it('binds by id, not by a hash of the whole control closure', () => {
    // Retiming an unrelated head, or enriching road controls elsewhere on the
    // map, must not invalidate a plan whose own junction and heads are live:
    // executability binds by immutable ids, not by a broad provenance digest.
    const retimed = programs.map((program) => program.id === 'signal:h2'
      ? { ...program, phases: [{ phase: 'green' as const, durationS: 3 }, ...program.phases.slice(1)] }
      : program);
    expect(() => compileMapSignalPlans(retimed, [plan], options)).not.toThrow();
  });

  it('fails closed when the bound junction is gone, or ownership is split', () => {
    const orphaned = programs.map((program) => ({ ...program, mapBinding: undefined }));
    expect(() => compileMapSignalPlans(orphaned, [plan], options))
      .toThrowError(expect.objectContaining({ code: 'map_signal_plan_junction_unbound' }));
    expect(() => compileMapSignalPlans(programs, [plan], { ...options, worldSignalSetIds: ['signal:h1'] }))
      .toThrowError(expect.objectContaining({ code: 'map_signal_plan_dual_ownership' }));
  });

  it('compiles from the signal catalog alone, and still enforces the stage rule', () => {
    // A browser caller compiles from the signal catalog alone. The
    // authoritative controller-stage rule is unaffected by derived artifacts.
    const browserOptions = options;
    expect(() => compileMapSignalPlans(programs, [plan], browserOptions)).not.toThrow();
    const compiled = compileMapSignalPlans(programs, [plan], browserOptions);
    expect(compiled.find((program) => program.id === 'signal:h1')?.mapBinding?.timingSource).toBe('authored');
    const inconsistent = programs.map((program) => program.id === 'signal:h1'
      ? { ...program, mapBinding: { ...program.mapBinding!, headIds: ['h1', 'h-not-in-controller'] } }
      : program);
    expect(() => compileMapSignalPlans(inconsistent, [plan], browserOptions)).toThrow();
  });

  it('fails closed when the referenced head is not in the exact controller head group', () => {
    const inconsistent = programs.map((program) => program.id === 'signal:h1' ? {
      ...program,
      mapBinding: {
        ...program.mapBinding!,
        controllerIds: ['c1', 'c2'],
        headIds: ['h1', 'hx'],
        controllerHeadGroups: [
          { controllerId: 'c1', headIds: ['hx'] },
          { controllerId: 'c2', headIds: ['h1'] },
        ],
      },
    } : program);
    const inconsistentDigest = contentHash({ signalPrograms: inconsistent, roadControls: [] });
    expect(() => compileMapSignalPlans(inconsistent, [{
      ...plan,
      binding: { ...plan.binding, controlDigest: inconsistentDigest },
    }], {
      ...options,
    })).toThrowError(expect.objectContaining({
      code: 'map_signal_plan_reference_unbound',
    } satisfies Partial<MapSignalPlanCompileError>));
  });

  it('treats published controller membership as authoritative over derived conflict geometry', () => {
    // The map's own declared controller-stage sequence is the authority on
    // what executes physically together. Derived gate geometry is advisory
    // context and must not reject a stage the physical map itself runs.
    const groupedPrograms = programs.map((program) => ({
      ...program,
      mapBinding: { ...program.mapBinding!, controllerIds: ['c1'], controllerHeadGroups: [{ controllerId: 'c1', headIds: program.mapBinding!.headIds }] },
    }));
    const groupedCatalog = { ...catalog, controllers: [{ id: 'c1', sequence: 0, signalIds: ['h1', 'h2'] }], junctions: [{ junctionId: 'j1', controllerIds: ['c1'] }] };
    const groupedDigest = contentHash({ signalPrograms: groupedPrograms, roadControls: [] });
    expect(() => compileMapSignalPlans(groupedPrograms, [{ ...plan, binding: { ...plan.binding, controlDigest: groupedDigest } }], {
      ...options, signalCatalog: groupedCatalog,
    })).not.toThrow();
  });
});
