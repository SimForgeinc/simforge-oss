import { describe, expect, it } from 'vitest';

import type { SignalProgram } from '../schema/input.js';
import {
  bindSumoLinksToSignalPrograms,
  mostRestrictiveSumoLinkState,
  parseSumoSignalNetwork,
  roadLaneKey,
  signalProgramIndicationAt,
  sumoLinkStateForIndication,
  synthesizeSumoSignalPrograms,
} from './sumo-signals.js';

/**
 * A four-link junction `J`: road 10 lane 1 (approach) → connecting roads 20
 * (straight) and 21 (left); road 11 lane -1 → connecting road 22 (straight)
 * and 23 (right). netconvert's own program is a two-phase cycle.
 */
const NETWORK = `<net>
    <location netOffset="0,0" convBoundary="0.00,0.00,200.00,200.00"/>
    <edge id=":J_0" function="internal">
        <lane id=":J_0_0" index="0" length="10" width="3.2" shape="0,0 10,0"><param key="origId" value="20_1"/></lane>
    </edge>
    <edge id=":J_1" function="internal">
        <lane id=":J_1_0" index="0" length="10" width="3.2" shape="0,0 10,0"><param key="origId" value="21_1"/></lane>
    </edge>
    <edge id=":J_2" function="internal">
        <lane id=":J_2_0" index="0" length="10" width="3.2" shape="0,0 10,0"><param key="origId" value="22_-1"/></lane>
    </edge>
    <edge id=":J_3" function="internal">
        <lane id=":J_3_0" index="0" length="10" width="3.2" shape="0,0 10,0"/>
    </edge>
    <edge id="a" from="X" to="J">
        <lane id="a_0" index="0" length="50" width="3.2" shape="0,100 50,100"><param key="origId" value="10_1"/></lane>
    </edge>
    <edge id="b" from="Y" to="J">
        <lane id="b_0" index="0" length="50" width="3.2" shape="100,0 100,50"><param key="origId" value="11_-1"/></lane>
    </edge>
    <tlLogic id="J" type="actuated" programID="0" offset="7">
        <phase duration="42" state="GGrr"/>
        <phase duration="3"  state="yyrr"/>
        <phase duration="42" state="rrGG"/>
        <phase duration="3"  state="rryy"/>
        <param key="linkSignalID:0" value="h1"/>
        <param key="linkSignalID:3" value="h2"/>
    </tlLogic>
    <connection from="a" to="c" fromLane="0" toLane="0" via=":J_0_0" tl="J" linkIndex="0" dir="s" state="O"/>
    <connection from="a" to="d" fromLane="0" toLane="0" via=":J_1_0" tl="J" linkIndex="1" dir="l" state="O"/>
    <connection from="b" to="e" fromLane="0" toLane="0" via=":J_2_0" tl="J" linkIndex="2" dir="s" state="O"/>
    <connection from="b" to="f" fromLane="0" toLane="0" via=":J_3_0" tl="J" linkIndex="3" dir="r" state="O"/>
</net>`;

function program(id: string, phases: SignalProgram['phases'], stopLines: SignalProgram['stopLines'], headIds: string[]): SignalProgram {
  return {
    id,
    phases,
    offsetS: 0,
    loop: true,
    stopLines,
    mapBinding: { junctionId: 'J', controllerIds: [], headIds, timingSource: 'map' },
  } as SignalProgram;
}

const NORTH = program('signal:n', [
  { phase: 'green', durationS: 10 },
  { phase: 'yellow', durationS: 2 },
  { phase: 'red', durationS: 12 },
], [{ rsl: '10:0:1', s: 49, connectingLaneRsls: ['20:0:1'] }], ['h1']);
const EAST = program('signal:e', [
  { phase: 'red', durationS: 12 },
  { phase: 'green', durationS: 10 },
  { phase: 'yellow', durationS: 2 },
], [{ rsl: '11:0:-1', s: 49, connectingLaneRsls: [] }], ['h2']);

describe('SUMO signal network parsing', () => {
  it('reads controlled links with OpenDRIVE provenance and head bindings', () => {
    const network = parseSumoSignalNetwork(NETWORK);
    expect(network.trafficLights).toEqual([
      expect.objectContaining({ id: 'J', type: 'actuated', linkCount: 4 }),
    ]);
    expect(network.links.map((link) => [link.linkIndex, link.fromOrigIds, link.viaOrigIds, link.headIds, link.toLane])).toEqual([
      [0, ['10_1'], ['20_1'], ['h1'], 'c_0'],
      [1, ['10_1'], ['21_1'], [], 'd_0'],
      [2, ['11_-1'], ['22_-1'], [], 'e_0'],
      [3, ['11_-1'], [], ['h2'], 'f_0'],
    ]);
  });

  it('maps SimForge and SUMO lane identities onto one key', () => {
    expect(roadLaneKey('10:0:1')).toBe('10_1');
    expect(roadLaneKey('11:2:-1')).toBe('11_-1');
    expect(roadLaneKey('bad')).toBeNull();
  });
});

describe('binding SUMO links to the SimForge signal book', () => {
  it('uses the engine braking rule: stop-line lane plus movement filter', () => {
    const bindings = bindSumoLinksToSignalPrograms(parseSumoSignalNetwork(NETWORK), [NORTH, EAST]);
    expect(bindings.map((binding) => [binding.linkIndex, binding.source, binding.programIds])).toEqual([
      [0, 'stop-line', ['signal:n']],
      // The movement filter names 20 only: the left turn via 21 is not governed.
      [1, 'none', []],
      // An empty filter governs every movement from the approach lane.
      [2, 'stop-line', ['signal:e']],
      [3, 'stop-line', ['signal:e']],
    ]);
  });

  it('falls back to head provenance only for programs on the same approach road', () => {
    const northAnyHead = program('signal:n2', NORTH.phases, [{ rsl: '10:0:1', s: 49, connectingLaneRsls: ['20:0:1'] }], ['h1', 'h9']);
    const network = parseSumoSignalNetwork(NETWORK.replace('<param key="linkSignalID:3" value="h2"/>', '<param key="linkSignalID:1" value="h9"/>'));
    const bindings = bindSumoLinksToSignalPrograms(network, [northAnyHead]);
    expect(bindings[1]).toMatchObject({ source: 'head', programIds: ['signal:n2'] });
    // h9 belongs to a program on road 10; link 3 comes from road 11 and stays unbound.
    expect(bindings[3]).toMatchObject({ source: 'none' });
  });

  it('binds SimForge stop controls when no program governs a link', () => {
    const bindings = bindSumoLinksToSignalPrograms(parseSumoSignalNetwork(NETWORK), [NORTH], [
      { id: 'stop:b', kind: 'stop', dwellS: 1, stopLines: [{ rsl: '11:0:-1', s: 49, connectingLaneRsls: [] }] },
    ]);
    expect(bindings[2]).toMatchObject({ source: 'road-control', roadControlIds: ['stop:b'] });
  });
});

describe('SimForge indications in SUMO', () => {
  it('maps every control indication to a SUMO link state', () => {
    expect(sumoLinkStateForIndication('green')).toBe('g');
    expect(sumoLinkStateForIndication('green_arrow')).toBe('g');
    expect(sumoLinkStateForIndication('yellow')).toBe('y');
    expect(sumoLinkStateForIndication('red')).toBe('r');
    expect(sumoLinkStateForIndication('red_x')).toBe('r');
    expect(sumoLinkStateForIndication('flashing_yellow')).toBe('o');
    expect(sumoLinkStateForIndication('flashing_red')).toBe('s');
    expect(sumoLinkStateForIndication('off')).toBe('s');
    expect(sumoLinkStateForIndication('off', 'uncontrolled')).toBe('O');
    expect(sumoLinkStateForIndication('off', 'yield')).toBe('o');
  });

  it('shows the most restrictive state when several programs govern one link', () => {
    expect(mostRestrictiveSumoLinkState(['g', 'y'])).toBe('y');
    expect(mostRestrictiveSumoLinkState(['g', 'r', 's'])).toBe('r');
    expect(mostRestrictiveSumoLinkState(['O', 'g'])).toBe('g');
  });

  it('evaluates programs exactly as the engine SignalBook does', () => {
    // Program starts at -warmup + offset; elapsed < accumulated duration selects the phase.
    expect(signalProgramIndicationAt(NORTH, -5, 5)).toBe('green');
    expect(signalProgramIndicationAt(NORTH, 4.98, 5)).toBe('green');
    expect(signalProgramIndicationAt(NORTH, 5, 5)).toBe('yellow');
    expect(signalProgramIndicationAt(NORTH, 7, 5)).toBe('red');
    // Loops, including negative time.
    expect(signalProgramIndicationAt(NORTH, 19, 5)).toBe('green');
    expect(signalProgramIndicationAt(NORTH, -30, 5)).toBe('red');
    expect(signalProgramIndicationAt(NORTH, -19, 5)).toBe('yellow');
    const once = { ...NORTH, loop: false };
    expect(signalProgramIndicationAt(once, -100, 0)).toBe('green');
    expect(signalProgramIndicationAt(once, 100, 0)).toBe('red');
  });
});

describe('tlLogic synthesis', () => {
  const synthesis = synthesizeSumoSignalPrograms(NETWORK, [NORTH, EAST], {
    stepSeconds: 0.02,
    stepCount: 1250,
    indication: (p, step) => signalProgramIndicationAt(p, step * 0.02, 0),
  });

  it('replaces netconvert timing with the book, step for step', () => {
    const logic = parseSumoSignalNetwork(synthesis.xml).trafficLights[0]!;
    expect(logic.type).toBe('static');
    expect(logic.offset).toBe(0);
    expect(logic.phases.map((phase) => [phase.duration, phase.state])).toEqual([
      [10, 'gorr'],
      [2, 'yorr'],
      [10, 'rogg'],
      [2, 'royy'],
      // 25 s of steps: the next cycle's first second, then that state is held for a day.
      [86_401, 'gorr'],
    ]);
    // Durations are exact whole-millisecond multiples of the step.
    const total = logic.phases.reduce((sum, phase) => sum + phase.duration, 0);
    expect(total).toBeGreaterThan(86_400);
    expect(logic.phases.every((phase) => Math.round(phase.duration * 1000) % 20 === 0)).toBe(true);
  });

  it('keeps head provenance params and reports bindings', () => {
    expect(synthesis.xml).toContain('<param key="linkSignalID:0" value="h1"/>');
    expect(synthesis.report).toMatchObject({
      trafficLights: 1,
      controlledLinks: 4,
      boundLinks: 3,
      unboundLinks: 1,
      linksBySource: { 'stop-line': 3, head: 0, 'road-control': 0, none: 1 },
      unboundTrafficLights: [],
      unusedProgramIds: [],
    });
  });

  it('is a pure function of its inputs', () => {
    const again = synthesizeSumoSignalPrograms(NETWORK, [EAST, NORTH], {
      stepSeconds: 0.02,
      stepCount: 1250,
      indication: (p, step) => signalProgramIndicationAt(p, step * 0.02, 0),
    });
    expect(again.xml).toBe(synthesis.xml);
  });

  it('refuses a step SUMO cannot represent exactly', () => {
    expect(() => synthesizeSumoSignalPrograms(NETWORK, [], { stepSeconds: 0.0205, stepCount: 1, indication: () => 'red' }))
      .toThrow(/whole-millisecond/);
  });
});
