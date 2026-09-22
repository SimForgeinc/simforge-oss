import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSource, baselineFrom, budgetOf, compareWithBaseline } from '../style/ratchet-lib.mjs';

const source = `
import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../stylex/tokens.stylex";
import { focus } from "../stylex/recipes.stylex";
const SM = "@media (min-width: 640px)";
const INK = "rgba(255, 255, 255, 0.45)";
export const styles = stylex.create({
  root: {
    color: INK,
    backgroundColor: colors.panel,
    padding: { default: space.md, [SM]: "1.25rem" },
    borderWidth: 0,
    zIndex: 20,
    width: "12rem",
    transitionDuration: "150ms",
  },
  tokenOnly: { gap: space.lg, borderColor: \`\${colors.accent}\` },
});
`;

test('counts literals in design properties, not tokens, neutrals or layout', () => {
  const result = analyzeSource('x.stylex.ts', source);
  assert.equal(result.creates, 1);
  assert.equal(result.keys, 2);
  // INK (via const), 1.25rem, zIndex 20, 150ms. `width` is layout, `0` is neutral.
  assert.equal(result.literals, 4);
  assert.equal(result.media, 1);
  assert.equal(result.tokens, 4);
  assert.equal(budgetOf(result), 5);
});

test('ignores files without stylex.create', () => {
  assert.equal(analyzeSource('y.ts', 'export const a = 1;'), null);
});

test('baseline only fails regressions and unknown files with literals', () => {
  const files = [
    { file: 'a.ts', literals: 3, media: 0, literalValues: [] },
    { file: 'b.ts', literals: 1, media: 1, literalValues: [] },
    { file: 'c.ts', literals: 1, media: 0, literalValues: [] },
  ];
  const baseline = { 'a.ts': 4, 'b.ts': 1, gone: 2 };
  const { violations, improvements } = compareWithBaseline(files, baseline);
  assert.deepEqual(violations.map((v) => [v.file, v.isNew]), [['b.ts', false], ['c.ts', true]]);
  assert.deepEqual(improvements.map((i) => i.file).sort(), ['a.ts', 'gone']);
  assert.deepEqual(baselineFrom(files), { 'a.ts': 3, 'b.ts': 2, 'c.ts': 1 });
});
