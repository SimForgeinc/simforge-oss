import { describe, expect, it } from 'vitest';

import {
  legacyTemplateSeed,
  parseTemplate,
  pinnedSimulationBlock,
  SIMULATION_DT_S,
  TemplateDocument,
  withPinnedSimulation,
} from '../index.js';
import { ltapTemplateInput } from './v2-fixtures.js';

describe('the pinned simulation block', () => {
  it('parses a 20 ms block and refuses any other step', () => {
    const template = parseTemplate({ ...ltapTemplateInput(), simulation: { seed: 'fixed', dtS: 0.02 } });
    expect(template.simulation).toEqual({ seed: 'fixed', dtS: SIMULATION_DT_S });
    expect(() => parseTemplate({ ...ltapTemplateInput(), simulation: { seed: 'fixed', dtS: 0.05 } })).toThrow();
    expect(() => parseTemplate({ ...ltapTemplateInput(), simulation: { seed: '', dtS: 0.02 } })).toThrow();
  });

  it('is optional, so documents written before pinning still parse', () => {
    expect(parseTemplate(ltapTemplateInput()).simulation).toBeUndefined();
  });

  it('pins the legacy seed: anchor id first, then the name', () => {
    const template = parseTemplate(ltapTemplateInput());
    const expected = template.anchor.id ?? template.meta.name;
    expect(legacyTemplateSeed(template)).toBe(expected);
    expect(pinnedSimulationBlock(template)).toEqual({ seed: expected, dtS: 0.02 });
    const unanchored = { ...template, anchor: { ...template.anchor, id: undefined } };
    expect(legacyTemplateSeed(unanchored)).toBe(template.meta.name);
  });

  it('withPinnedSimulation keeps an existing block and is idempotent', () => {
    const template = parseTemplate({ ...ltapTemplateInput(), simulation: { seed: 'kept', dtS: 0.02 } });
    expect(withPinnedSimulation(template)).toBe(template);
    const pinned = withPinnedSimulation(parseTemplate(ltapTemplateInput()));
    expect(withPinnedSimulation(pinned)).toBe(pinned);
    expect(parseTemplate(pinned).simulation).toEqual(pinned.simulation);
  });

  it('new documents are born pinned, and a rename keeps the seed', () => {
    const document = TemplateDocument.create({ name: 'Born pinned', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(document.data.simulation).toEqual({ seed: 'Born pinned', dtS: 0.02 });
  });
});
