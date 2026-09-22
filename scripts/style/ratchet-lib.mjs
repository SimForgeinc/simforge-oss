/**
 * Literal accounting for Studio's StyleX.
 *
 * Walks every `stylex.create` / `stylex.keyframes` call under the two Studio
 * trees and classifies each declaration value as a token reference, a raw
 * literal, or something structural. The ratchet (`ratchet.mjs`) uses the
 * per-file literal counts; the report uses the totals.
 *
 * What counts as a literal: a string, number or literal-only template in a
 * design-bearing property (colour, spacing, type, stroke, shadow, stacking,
 * motion, blur) that is not a neutral keyword (`0`, `none`, `auto`,
 * `transparent`, `inherit`, `currentColor`, `100%`, ...). A value read through
 * a local `const` counts as the literal it holds; a value read from a token or
 * recipe module does not. A `@media (min-width…)` condition written as a
 * string, directly or through a local const, counts once per use.
 *
 * Dependency-free apart from `typescript`, which the repository root already
 * installs, so it runs before any package is built.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

/** Trees that hold Studio styling, relative to the repository root. */
export const STYLE_ROOTS = ["packages/studio-ui/src", "studio/app"];

/** Modules whose exports are design tokens or recipes: references to them are not literals. */
export const TOKEN_MODULE = /(?:^|\/)(?:tokens|motion|recipes|drive)\.stylex(?:\.ts)?$|\/stylex\/(?:tokens|recipes|motion)(?:\.stylex)?$|studio-ui\/stylex\//;

export const CATEGORIES = [
  ["color", /^(color|backgroundColor|border(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?Color|outlineColor|fill|stroke|caretColor|textDecorationColor|accentColor|stopColor|columnRuleColor)$/],
  ["spacing", /^(padding|margin|inset|scrollMargin|scrollPadding)(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?$|^(gap|rowGap|columnGap)$/],
  ["fontSize", /^fontSize$/],
  ["lineHeight", /^lineHeight$/],
  ["letterSpacing", /^letterSpacing$/],
  ["fontWeight", /^fontWeight$/],
  ["fontFamily", /^fontFamily$/],
  ["radius", /^border(Top|Bottom|Start|End)?(Left|Right|Start|End)?Radius$/],
  ["borderWidth", /^border(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?Width$|^outlineWidth$/],
  ["shadow", /^(boxShadow|textShadow)$/],
  ["zIndex", /^zIndex$/],
  ["duration", /^(transition|animation)(Duration|Delay)$/],
  ["easing", /^(transition|animation)TimingFunction$/],
  ["blur", /^(backdropFilter|WebkitBackdropFilter)$/],
];

/** The categories the audit's headline "core literal %" is computed over. */
export const CORE = new Set(["color", "spacing", "fontSize", "radius", "shadow", "zIndex", "duration", "easing"]);

const NEUTRAL = new Set([
  "0", "0px", "0s", "0ms", "none", "transparent", "inherit", "initial", "unset", "revert",
  "currentcolor", "auto", "normal", "100%", "50%", "1", "-1", "",
]);

export function categoryOf(prop) {
  const hit = CATEGORIES.find(([, re]) => re.test(prop));
  return hit ? hit[0] : null;
}

function isNeutral(category, value) {
  const v = String(value).trim().toLowerCase();
  if (NEUTRAL.has(v)) return true;
  if (category === "zIndex" && /^-?[0-2]$/.test(v)) return true;
  if (category === "spacing" && /^-?\d+(\.\d+)?%$|^calc\(/.test(v)) return true;
  if (category === "lineHeight" && /^[01]$/.test(v)) return true;
  return false;
}

const MEDIA_LITERAL = /^@media\s*\((min|max)-width/;

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "__tests__") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$|\.(test|spec)\.tsx?$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

/** Every TS/TSX source under the style roots, as repository-relative POSIX paths. */
export function listStyleSources(repoRoot, roots = STYLE_ROOTS) {
  const files = [];
  for (const root of roots) walk(join(repoRoot, root), files);
  return files.map((file) => relative(repoRoot, file).split(sep).join("/")).sort();
}

/**
 * Analyse one source file. Returns `null` when the file holds no
 * `stylex.create`/`keyframes` call.
 */
export function analyzeSource(fileName, source) {
  if (!source.includes("@stylexjs/stylex")) return null;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const imports = new Map();
  const consts = new Map();
  const stylexNames = new Set();
  const createNames = new Set();
  const keyframesNames = new Set();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, spec);
      if (spec === "@stylexjs/stylex") stylexNames.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, spec);
        const imported = (element.propertyName ?? element.name).text;
        if (spec === "@stylexjs/stylex" && imported === "create") createNames.add(element.name.text);
        if (spec === "@stylexjs/stylex" && imported === "keyframes") keyframesNames.add(element.name.text);
      }
    }
    if (statement.importClause?.name) imports.set(statement.importClause.name.text, spec);
  }
  (function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) consts.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  })(sf);

  const calleeKind = (call) => {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && stylexNames.has(callee.expression.text)) {
      if (callee.name.text === "create") return "create";
      if (callee.name.text === "keyframes") return "keyframes";
    }
    if (ts.isIdentifier(callee) && createNames.has(callee.text)) return "create";
    if (ts.isIdentifier(callee) && keyframesNames.has(callee.text)) return "keyframes";
    return null;
  };

  const isTokenRoot = (name) => {
    const spec = imports.get(name);
    if (spec && TOKEN_MODULE.test(spec)) return true;
    const init = consts.get(name);
    return Boolean(init && ts.isCallExpression(init) && /define(Vars|Consts)$/.test(init.expression.getText(sf)));
  };

  /** kind: literal | token | mixed | other */
  function classify(node, depth = 0) {
    if (!node || depth > 6) return { kind: "other" };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) return classify(node.expression, depth);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "literal", value: node.text };
    if (ts.isNumericLiteral(node)) return { kind: "literal", value: Number(node.text) };
    if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return { kind: "literal", value: -Number(node.operand.text) };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: "null" };
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let root = node;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root) && isTokenRoot(root.text)) return { kind: "token" };
      return { kind: "other" };
    }
    if (ts.isIdentifier(node)) {
      if (isTokenRoot(node.text)) return { kind: "token" };
      const init = consts.get(node.text);
      if (init) {
        if (ts.isCallExpression(init)) return { kind: "other" };
        return classify(init, depth + 1);
      }
      return { kind: "other" };
    }
    if (ts.isTemplateExpression(node)) {
      const parts = node.templateSpans.map((span) => classify(span.expression, depth + 1));
      if (parts.some((part) => part.kind === "token" || part.kind === "mixed")) return { kind: "mixed" };
      if (parts.every((part) => part.kind === "literal")) {
        let value = node.head.text;
        node.templateSpans.forEach((span, index) => {
          value += String(parts[index].value) + span.literal.text;
        });
        return { kind: "literal", value };
      }
      return { kind: "other" };
    }
    return { kind: "other" };
  }

  const keyText = (name) => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return { text: name.text, computed: null };
    if (ts.isComputedPropertyName(name)) {
      const resolved = classify(name.expression);
      return { text: resolved.kind === "literal" ? String(resolved.value) : name.getText(sf), computed: resolved };
    }
    return { text: name.getText(sf), computed: null };
  };

  const result = { file: fileName, creates: 0, keyframes: 0, keys: 0, literals: 0, tokens: 0, media: 0, byCategory: {}, literalValues: [] };
  const bump = (category, field) => {
    result.byCategory[category] ??= { literal: 0, token: 0 };
    result.byCategory[category][field] += 1;
  };
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  function visitStyle(object, property, depth) {
    if (depth > 8) return;
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) {
        const target = member.expression;
        if (ts.isIdentifier(target)) {
          const init = consts.get(target.text);
          if (init && ts.isObjectLiteralExpression(init)) visitStyle(init, property, depth + 1);
        }
        continue;
      }
      if (!ts.isPropertyAssignment(member)) continue;
      const key = keyText(member.name);
      if (MEDIA_LITERAL.test(key.text) && (key.computed === null || key.computed.kind === "literal")) {
        result.media += 1;
        result.literalValues.push({ line: line(member), category: "media", value: key.text });
      }
      const isCondition = key.text === "default" || /^[:@[]/.test(key.text) || key.computed !== null;
      let init = member.initializer;
      if (ts.isIdentifier(init)) {
        const resolved = consts.get(init.text);
        if (resolved && ts.isObjectLiteralExpression(resolved)) init = resolved;
      }
      if (ts.isObjectLiteralExpression(init)) {
        visitStyle(init, property ?? (isCondition ? null : key.text), depth + 1);
        continue;
      }
      const prop = property ?? key.text;
      const category = categoryOf(prop);
      if (!category) continue;
      const value = classify(init);
      if (value.kind === "token" || value.kind === "mixed") {
        result.tokens += 1;
        bump(category, "token");
      } else if (value.kind === "literal" && !isNeutral(category, value.value)) {
        result.literals += 1;
        bump(category, "literal");
        result.literalValues.push({ line: line(member), category, prop, value: value.value });
      }
    }
  }

  (function visit(node) {
    if (ts.isCallExpression(node)) {
      const kind = calleeKind(node);
      const arg = node.arguments[0];
      if (kind === "keyframes") {
        result.keyframes += 1;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const frame of arg.properties) {
            if (ts.isPropertyAssignment(frame) && ts.isObjectLiteralExpression(frame.initializer)) visitStyle(frame.initializer, null, 1);
          }
        }
      }
      if (kind === "create" && arg && ts.isObjectLiteralExpression(arg)) {
        result.creates += 1;
        for (const namespace of arg.properties) {
          result.keys += 1;
          let body = ts.isPropertyAssignment(namespace) ? namespace.initializer : null;
          if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
            body = body.body;
            if (body && ts.isParenthesizedExpression(body)) body = body.expression;
          }
          if (body && ts.isIdentifier(body)) {
            const resolved = consts.get(body.text);
            if (resolved && ts.isObjectLiteralExpression(resolved)) body = resolved;
          }
          if (body && ts.isObjectLiteralExpression(body)) visitStyle(body, null, 0);
        }
      }
    }
    ts.forEachChild(node, visit);
  })(sf);

  if (result.creates === 0 && result.keyframes === 0) return null;
  return result;
}

/** Analyse every style source under `repoRoot`. */
export function analyzeRepository(repoRoot, roots = STYLE_ROOTS) {
  const files = [];
  for (const file of listStyleSources(repoRoot, roots)) {
    const analysis = analyzeSource(file, readFileSync(join(repoRoot, file), "utf8"));
    if (analysis) files.push(analysis);
  }
  return files;
}

/** Budget a file is held to: every counted literal plus every literal breakpoint. */
export const budgetOf = (analysis) => analysis.literals + analysis.media;

export function summarize(files) {
  const categories = {};
  let literals = 0;
  let tokens = 0;
  let coreLiterals = 0;
  let coreTokens = 0;
  let media = 0;
  let keyframes = 0;
  for (const file of files) {
    literals += file.literals;
    tokens += file.tokens;
    media += file.media;
    keyframes += file.keyframes;
    for (const [category, counts] of Object.entries(file.byCategory)) {
      categories[category] ??= { literal: 0, token: 0 };
      categories[category].literal += counts.literal;
      categories[category].token += counts.token;
      if (CORE.has(category)) {
        coreLiterals += counts.literal;
        coreTokens += counts.token;
      }
    }
  }
  const pct = (a, b) => (a + b === 0 ? 0 : Math.round((1000 * a) / (a + b)) / 10);
  return {
    files: files.length,
    literals,
    tokens,
    literalPct: pct(literals, tokens),
    coreLiteralPct: pct(coreLiterals, coreTokens),
    media,
    keyframes,
    categories,
  };
}

/**
 * Compare current budgets with a baseline. A file over its baseline, or a file
 * the baseline does not know that carries any literal, is a violation.
 */
export function compareWithBaseline(files, baseline) {
  const violations = [];
  const improvements = [];
  const seen = new Set();
  for (const file of files) {
    seen.add(file.file);
    const budget = budgetOf(file);
    const allowed = baseline[file.file];
    if (allowed === undefined) {
      if (budget > 0) violations.push({ file: file.file, allowed: 0, actual: budget, isNew: true, values: file.literalValues });
    } else if (budget > allowed) {
      violations.push({ file: file.file, allowed, actual: budget, isNew: false, values: file.literalValues });
    } else if (budget < allowed) {
      improvements.push({ file: file.file, allowed, actual: budget });
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!seen.has(file) && allowed > 0) improvements.push({ file, allowed, actual: 0 });
  }
  return { violations, improvements };
}

export function baselineFrom(files) {
  const out = {};
  for (const file of files) {
    const budget = budgetOf(file);
    if (budget > 0) out[file.file] = budget;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
