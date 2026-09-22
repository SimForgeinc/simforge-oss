/**
 * StyleX lint for Studio. Run through `pnpm lint:style` (scripts/style/lint.mjs),
 * from the repository root, so the globs below are root-relative.
 *
 * The toolchain is installed in this directory on its own lockfile so adding
 * it never touches the workspace install. Errors fail CI; warnings are the
 * backlog the style guide describes and are printed, not enforced.
 *
 *  - `@stylexjs/no-unused`: a `stylex.create` key nothing reads is dead weight
 *    and, worse, a template the next agent copies.
 *  - `@stylexjs/enforce-extension`: `defineVars`/`defineConsts` only in
 *    `*.stylex.ts`. Applied to every *other* file: the component style
 *    modules are also named `*.stylex.ts` by convention and export
 *    `stylex.create`, which the rule's second half would reject.
 *  - `@stylexjs/no-conflicting-props` (warn): `className`/`style` beside a
 *    `stylex.props()` spread. A `style` carrying a runtime custom property is
 *    the documented way to pass live values, so this stays a warning; a
 *    `className` there is always wrong (see the ban below).
 *  - `no-restricted-syntax`: the style-guide bans no StyleX rule covers. Each
 *    message names the replacement.
 */
import stylex from "@stylexjs/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { builtinRules } from "eslint/use-at-your-own-risk";

const SOURCES = ["packages/studio-ui/src/**/*.{ts,tsx}", "studio/app/**/*.{ts,tsx}"];
const NOT_TESTS = ["**/__tests__/**", "**/*.test.*", "**/*.d.ts"];

/**
 * The token and recipe modules are the only places allowed to hold the banned
 * forms, plus the two primitives that are round by construction.
 */
const FOUNDATION = [
  "packages/studio-ui/src/stylex/**",
  "packages/studio-ui/src/drive/drive.stylex.ts",
  "packages/studio-ui/src/components/ui/spinner.tsx",
  "packages/studio-ui/src/components/ui/dot.tsx",
];

/**
 * Sources carry `eslint-disable` comments for rules from the Next/React/TS
 * configs this lint does not load. A rule named in a directive must exist, so
 * those names resolve to a rule that never reports.
 */
const noop = { meta: { type: "suggestion", schema: false }, create: () => ({}) };
const stub = { rules: new Proxy({}, { get: () => noop, has: () => true }) };

/**
 * `no-restricted-syntax` takes one severity for all its selectors, so the
 * bans that are enforced and the ones that are only reported run as two
 * copies of the same core rule.
 */
const studio = {
  rules: {
    "banned-syntax": builtinRules.get("no-restricted-syntax"),
    "discouraged-syntax": builtinRules.get("no-restricted-syntax"),
  },
};

/** Enforced: the forms the style guide forbids outright. */
const banned = [
  {
    selector: "CallExpression[callee.property.name='create'] Property[key.name=/^border(Top|Bottom|Start|End)?(Left|Right|Start|End)?Radius$/]",
    message: "Studio is square: the global reset zeroes every radius. Use <Spinner>/<Dot> for round things.",
  },
  {
    // Only a property's single width query: several on one property stay
    // literal so StyleX can turn them into ranges (see the style guide).
    selector: "CallExpression[callee.property.name='create'] > ObjectExpression > Property > ObjectExpression > Property > ObjectExpression:not(:has(> Property[key.value=/^@media \\((min|max)-width/] ~ Property[key.value=/^@media \\((min|max)-width/])) > Property[key.type='Literal'][key.value=/^@media \\((min|max)-width/]",
    message: "Literal breakpoint. Use `[layout.bpSm]` (bpMd, bpLg, bpXl) from tokens.stylex.",
  },
  {
    selector: "CallExpression[callee.property.name='keyframes']",
    message: "Keyframes live in stylex/recipes.stylex.ts. Use `motionRecipe.*` or the <Spinner>/<Dot> primitives.",
  },
  {
    selector: "JSXOpeningElement:has(JSXSpreadAttribute > CallExpression[callee.property.name='props']) > JSXAttribute[name.name='className']",
    message: "`className` beside a `stylex.props()` spread loses to the atoms. Pass StyleX through `xstyle` or compose it into the same props() call.",
  },
];

/** Reported: debt that is fixed when a file is next touched. */
const discouraged = [
  {
    selector: "CallExpression[callee.property.name='create'] > ObjectExpression > Property > Identifier.key[name=/(^s_\\d+$|[a-z]\\d+$)/]",
    message: "Style keys are named by role (`header`, `rowActive`), not numbered. See the style guide.",
  },
];

export default [
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { "@stylexjs": stylex, studio, "@next/next": stub, "react-hooks": stub, "@typescript-eslint": stub },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: SOURCES,
    ignores: NOT_TESTS,
    rules: {
      "@stylexjs/no-unused": "error",
      "@stylexjs/no-conflicting-props": "warn",
    },
  },
  {
    files: SOURCES,
    ignores: ["**/*.stylex.ts", ...NOT_TESTS],
    rules: { "@stylexjs/enforce-extension": "error" },
  },
  {
    files: SOURCES,
    ignores: [...FOUNDATION, ...NOT_TESTS],
    rules: {
      "studio/banned-syntax": ["error", ...banned],
      "studio/discouraged-syntax": ["warn", ...discouraged],
    },
  },
];
