import { describe, expect, it } from 'vitest';

import { flashOn, resolveFrameSignals, signalBindingWarnings, signalHeadGuids, signalLens } from './signal-heads.js';

const XODR = `<OpenDRIVE>
  <road id="1"><signals>
    <signal name="Signal_3Light_Post01" id="5814" s="9.02" t="1.95" dynamic="yes" type="1000011">
      <validity fromLane="0" toLane="0"/>
      <userData><vectorSignal signalId="{792C9DF6-88ce-45b8-a711-1db32acf567e}"/></userData>
    </signal>
    <signal name="" id="6042" s="36.39" t="0" dynamic="yes" type="1000011" subtype="20">
      <userData><vectorSignal gateId="{20088a8a-026f-4b13-9474-fcf658954885}" turnRelation="Right"/></userData>
    </signal>
    <signal name="Signal_3Light_Bare01" id="5815" s="2" t="0"><userData><vectorSignal signalId="{00000000-0000-4000-8000-000000000002}"/></userData></signal>
    <signal id="7000" s="1" t="0"/>
    <signalReference id="5814" s="0" t="0" orientation="-"><userData><vectorSignal signalId="{792c9df6-88ce-45b8-a711-1db32acf567e}" gateId="{5831289a-2b73-4c31-a702-bb70a90b80ba}"/></userData></signalReference>
  </signals></road>
</OpenDRIVE>`;

describe('signal heads', () => {
  it('binds OpenDRIVE signal ids to the GLB head GUID of their vectorSignal asset', () => {
    expect([...signalHeadGuids(XODR)]).toEqual([
      ['5814', '{792c9df6-88ce-45b8-a711-1db32acf567e}'],
      ['5815', '{00000000-0000-4000-8000-000000000002}'],
    ]);
  });

  it('lights exactly one lens per indication, flashing on the timeline clock', () => {
    expect(signalLens('red', 3.2)).toEqual({ lens: 'red', substituted: false });
    expect(signalLens('yellow', 0)).toEqual({ lens: 'yellow', substituted: false });
    expect(signalLens('off', 0)).toEqual({ lens: 'off', substituted: false });
    expect(flashOn(0)).toBe(true);
    expect(flashOn(0.49)).toBe(true);
    expect(flashOn(0.5)).toBe(false);
    expect(signalLens('flashing_red', 2.25).lens).toBe('red');
    expect(signalLens('flashing_red', 2.75).lens).toBe('off');
    expect(signalLens('green_arrow', 0)).toEqual({ lens: 'green', substituted: true });
    expect(signalLens('stop', 0)).toEqual({ lens: 'red', substituted: true });
    expect(() => signalLens('purple', 0)).toThrow(/native_signal_indication_unknown/);
  });

  it('resolves a frame by head GUID and records what it cannot bind', () => {
    const guids = signalHeadGuids(XODR);
    guids.set('5816', '{792c9df6-88ce-45b8-a711-1db32acf567e}');
    const evidence = { unbound: new Set<string>(), conflicts: new Map<string, Set<string>>(), substituted: new Set<string>() };
    const frame = resolveFrameSignals(
      { 'signal:5814': 'red', 'signal:5816': 'green', 'signal:5815': 'green_arrow', 'signal:6042': 'green' },
      1.0, guids, evidence,
    );
    expect(frame).toEqual({
      '{792c9df6-88ce-45b8-a711-1db32acf567e}': 'red',
      '{00000000-0000-4000-8000-000000000002}': 'green',
    });
    expect([...evidence.unbound]).toEqual(['6042']);
    expect([...evidence.conflicts.get('{792c9df6-88ce-45b8-a711-1db32acf567e}')!].sort()).toEqual(['5814', '5816']);
    const codes = signalBindingWarnings({
      unbound: [...evidence.unbound],
      conflicts: new Map([...evidence.conflicts].map(([g, ids]) => [g, [...ids].sort()])),
      substituted: [...evidence.substituted],
    }).map((w) => w.code);
    expect(codes).toEqual(['native_signal_unbound', 'native_signal_head_conflict', 'native_signal_lens_substituted']);
    expect(() => resolveFrameSignals({ '5814': 'red' }, 0, guids, evidence)).toThrow(/native_signal_key_invalid/);
  });
});
