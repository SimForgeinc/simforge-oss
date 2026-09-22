#!/usr/bin/env node
/**
 * Moves `<Button>`/`<Input>` reskins from `xstyle` onto `variant`/`size`.
 *
 * For every `<Button xstyle={…}>` / `<Input xstyle={…}>` whose style keys
 * are used only as that primitive's `xstyle`, the codemod reads the look the
 * keys write out (height, background, ink, border, type size), picks the
 * primitive's `size` and `variant` that give that look on the shared control
 * scale, sets those props, and deletes the skin declarations from the keys
 * (dropping keys, and the `xstyle` itself, that end up empty). Placement
 * (width, margin, flex, alignment) stays in `xstyle`.
 *
 * This changes what renders: a 2.25rem button with a hand-made hairline
 * becomes the `outline` variant at `md`. Review with screenshots.
 *
 * Usage: node scripts/style/control-codemod.mjs [--dry] [--exclude-file f] [--report f]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, collectReferences, loadModels, resolveSpecifier, staticValue, ts } from "./codemod-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const opt = (n) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
const excl = [];
if (opt("exclude-file")) for (const l of readFileSync(opt("exclude-file"), "utf8").split("\n")) if (l.trim() && !l.startsWith("#")) excl.push(l.trim());
const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002").replace(/\*/g, "[^/]*").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*") + "$");
const exRe = excl.map(globToRe);
const isExcluded = (f) => exRe.some((r) => r.test(f));

const tokenValues = new Map();
{
  const src = readFileSync(join(repoRoot, "packages/studio-ui/src/stylex/tokens.stylex.ts"), "utf8");
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
    const call = d.initializer;
    if (!call || !ts.isCallExpression(call) || !call.arguments[0] || !ts.isObjectLiteralExpression(call.arguments[0])) continue;
    for (const p of call.arguments[0].properties) if (ts.isPropertyAssignment(p)) tokenValues.set(`${d.name.getText(sf)}.${p.name.getText(sf)}`, staticValue(p.initializer, new Map()));
  }
}

const models = loadModels(repoRoot);
const byFile = new Map(models.map((m) => [m.file, m]));
const refs = collectReferences(models, repoRoot);

/** Value of a declaration as a comparable string (token refs resolved, lowercase). */
function valueOf(m, node) {
  const v = staticValue(node, m.consts);
  if (v !== undefined) return v === null ? null : String(v).toLowerCase().replace(/\s+/g, "");
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const imp = m.imports.get(node.expression.text);
    if (imp && /tokens\.stylex$/.test(imp.spec)) {
      const tv = tokenValues.get(`${imp.imported}.${node.name.text}`);
      return `@${imp.imported}.${node.name.text}=${String(tv).toLowerCase().replace(/\s+/g, "")}`;
    }
  }
  return `?${node.getText(m.sf)}`;
}

const HEIGHT_TO_SIZE = { "1.5rem": "xs", "24px": "xs", "1.75rem": "sm", "28px": "sm", "2rem": "md", "32px": "md", "2.25rem": "md", "36px": "md", "2.5rem": "lg", "40px": "lg", "2.75rem": "xl", "3rem": "xl", "48px": "xl" };
const ICON_SIZE = { xs: "iconXs", sm: "iconSm", md: "iconMd", lg: "icon", xl: "icon" };

function classifyColor(v) {
  if (v === undefined || v === null) return "none";
  if (/transparent/.test(v)) return "transparent";
  if (/accent=#e8e044|#e8e044|rgb\(232224681\)|rgb\(232 224 68\)|--primary\)\)?$|@colors\.primary=/.test(v) && !/\/0\.[0-4]|0\.[0-4]\)$/.test(v)) return "accent";
  if (/232,224,68|23222468|@colors\.accent(wash|line|linesubtle|soft)/.test(v) || /--primary\)\/|--primary\)\s*\//.test(v)) return "accentAlpha";
  if (/accenttext|#0a0a0a|#000|rgb\(0001\)|black|primaryforeground/.test(v)) return "dark";
  if (/fca5a5|252,165,165|252165165|critical|destructive|danger/.test(v)) return "critical";
  if (/#fff|white|255,255,255|255255255|@colors\.(ink|text|textonplate)=|--foreground/.test(v)) return "light";
  if (/@colors\.(hairline|line|linestrong|border|input|glass|chip|fill)|--border|--input|--card|--background|--muted/.test(v)) return "plate";
  return "other";
}

const report = [];
const plans = [];
const edits = new Map(); // file -> [[s,e,text]]
const push = (file, e) => { if (!edits.has(file)) edits.set(file, []); edits.get(file).push(e); };
const keyUses = new Map(); // style key id -> [{file, tag, isXstyle}]

// Index every reference of every key and whether it sits in a Button/Input xstyle.
function jsxTagOf(node) {
  for (let a = node.parent; a; a = a.parent) {
    if (ts.isJsxAttribute(a)) {
      const el = a.parent?.parent;
      return { attr: a.name.getText(), tag: el && (ts.isJsxOpeningElement(el) || ts.isJsxSelfClosingElement(el)) ? el.tagName.getText() : null, element: el };
    }
    if (ts.isCallExpression(a) || ts.isJsxExpression(a) === false && ts.isBlock(a)) return null;
  }
  return null;
}
for (const [id, r] of refs) {
  for (const ref of r.refs) {
    const k = `${id}#${ref.key}`;
    if (!keyUses.has(k)) keyUses.set(k, []);
    keyUses.get(k).push({ file: ref.file, jsx: jsxTagOf(ref.node) });
  }
}

/** Primitives whose own role now owns these properties outright. */
const OWNED = {
  CardTitle: ["fontSize", "fontWeight", "lineHeight", "letterSpacing", "fontFamily", "color"],
};
const TAGS = ["Button", "Input", ...Object.keys(OWNED)];
const primitiveImport = (m, tag) => {
  const imp = m.imports.get(tag);
  if (!imp) return false;
  if (tag === "Button") return /(ui\/button|^\.\/button)$/.test(imp.spec);
  if (tag === "Input") return /(ui\/input|^\.\/input)$/.test(imp.spec);
  return /(ui\/card|^\.\/card)$/.test(imp.spec);
};

for (const m of models) {
  if (isExcluded(m.file)) continue;
  const local = new Map();
  for (const c of m.creates) if (c.binding) local.set(c.binding, `${m.file}#${c.binding}`);
  for (const [name, imp] of m.imports) {
    const t = resolveSpecifier(m.file, imp.spec, repoRoot);
    if (t && byFile.has(t) && imp.imported !== "*") local.set(name, `${t}#${imp.imported}`);
  }
  (function visit(n) {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && TAGS.includes(n.tagName.getText(m.sf)) && primitiveImport(m, n.tagName.getText(m.sf))) {
      handle(m, n, local);
    }
    ts.forEachChild(n, visit);
  })(m.sf);
}

function handle(m, el, local) {
  const tag = el.tagName.getText(m.sf);
  const attrs = el.attributes.properties;
  const attr = (name) => attrs.find((a) => ts.isJsxAttribute(a) && a.name.getText(m.sf) === name);
  const x = attr("xstyle");
  if (!x || !x.initializer || !ts.isJsxExpression(x.initializer)) return;
  const expr = x.initializer.expression;
  // Only plain references and arrays of them: a conditional skin (a toggle) stays as it is.
  const items = ts.isArrayLiteralExpression(expr) ? [...expr.elements] : [expr];
  const keys = [];
  for (const it of items) {
    if (!ts.isPropertyAccessExpression(it) || !ts.isIdentifier(it.expression) || !local.has(it.expression.text)) return;
    const id = `${local.get(it.expression.text)}#${it.name.text}`;
    const [file, binding] = local.get(it.expression.text).split("#");
    const model = byFile.get(file);
    const create = model?.creates.find((c) => c.binding === binding);
    const ns = create?.namespaces.find((q) => q.key === it.name.text);
    if (!ns || ns.unsupported || ns.dynamic || isExcluded(file)) return;
    const uses = keyUses.get(id) ?? [];
    const exclusive = uses.every((u) => u.jsx && u.jsx.attr === "xstyle" && u.jsx.tag === tag);
    keys.push({ node: it, id, ns, model, exclusive });
  }
  if (!keys.length) return;
  // Union of the keys' top-level declarations, later keys winning.
  const tops = new Map();
  for (const k of keys) {
    const seen = new Set();
    for (const d of k.ns.decls) {
      if (seen.has(d.top)) continue;
      seen.add(d.top);
      const prop = d.top.name.getText(k.model.sf).replace(/["']/g, "");
      const def = k.ns.decls.filter((q) => q.top === d.top && q.conds.length === 0)[0];
      tops.set(prop, { key: k, top: d.top, value: def ? valueOf(k.model, def.valueNode) : undefined, conditional: k.ns.decls.some((q) => q.top === d.top && q.conds.length) });
    }
  }
  const variantAttr = attr("variant");
  const sizeAttr = attr("size");
  const variant = variantAttr?.initializer && ts.isStringLiteral(variantAttr.initializer) ? variantAttr.initializer.text : variantAttr ? "?" : "default";
  const size = sizeAttr?.initializer && ts.isStringLiteral(sizeAttr.initializer) ? sizeAttr.initializer.text : sizeAttr ? "?" : "default";
  if (variant === "?" || size === "?") return;

  const strip = new Set();
  let newSize = null;
  let newVariant = null;
  if (OWNED[tag]) {
    for (const p of OWNED[tag]) if (tops.has(p)) strip.add(p);
  } else {
  const h = tops.get("height")?.value;
  const w = tops.get("width")?.value;
  if (h && HEIGHT_TO_SIZE[h]) {
    const step = HEIGHT_TO_SIZE[h];
    const square = size.startsWith("icon") || (w && w === h);
    newSize = tag === "Input" ? (step === "xl" ? "lg" : step) : square ? ICON_SIZE[step] : step;
    // Padding stays: an inset for an icon or an asymmetric pad is placement,
    // and the caller's value simply wins over the size's.
    for (const p of ["height", "minHeight", "fontSize", "lineHeight"]) if (tops.has(p)) strip.add(p);
    if (square && tops.has("width") && w === h) strip.add("width");
  }
  if (tag === "Button") {
    const bg = classifyColor(tops.get("backgroundColor")?.value);
    const ink = classifyColor(tops.get("color")?.value);
    const border = tops.has("borderColor") || tops.has("borderWidth") ? classifyColor(tops.get("borderColor")?.value ?? "@colors.hairline=") : "none";
    if (bg === "accent" && (ink === "dark" || ink === "none")) newVariant = "accent";
    else if ((ink === "accent" || ink === "accentAlpha") && (border === "accentAlpha" || border === "accent")) newVariant = "accentOutline";
    else if (bg === "critical" || ink === "critical") newVariant = "destructive";
    else if (border !== "none" && ["none", "transparent", "plate", "light", "other"].includes(bg) && ["none", "light", "plate", "other"].includes(ink)) newVariant = "outline";
    else if (border === "none" && ["none", "transparent"].includes(bg) && ["none", "light", "plate", "other", "dark"].includes(ink) && variant === "ghost") newVariant = "ghost";
    if (newVariant) for (const p of ["backgroundColor", "color", "borderColor", "borderWidth", "borderStyle", "borderTopWidth", "borderBottomWidth", "fontWeight", "transitionProperty", "transitionDuration", "transitionTimingFunction", "outline", "outlineWidth", "outlineStyle", "outlineColor", "outlineOffset", "boxShadow", "opacity", "cursor"]) if (tops.has(p)) strip.add(p);
  } else {
    const bg = classifyColor(tops.get("backgroundColor")?.value);
    if (["plate", "light", "other", "none"].includes(bg)) {
      newVariant = "plate";
      for (const p of ["backgroundColor", "color", "borderColor", "borderWidth", "borderStyle", "outline", "outlineWidth", "outlineStyle", "outlineColor", "outlineOffset", "boxShadow"]) if (tops.has(p)) strip.add(p);
    }
  }
  }
  if (!strip.size) return;
  // Every key we strip from must be exclusive to this primitive's xstyle.
  const touched = new Set([...strip].map((p) => tops.get(p).key));
  if ([...touched].some((k) => !k.exclusive)) return;

  const where = `${m.file}:${m.sf.getLineAndCharacterOfPosition(el.getStart(m.sf)).line + 1}`;
  plans.push({ where, tag, m, el, variant, size, variantAttr, sizeAttr, newVariant, newSize, strip, tops });
}

/**
 * A declaration leaves a shared key only if every element that reads the key
 * is converted and asks for the same declarations to go; otherwise an element
 * would lose its look without gaining the variant that replaces it.
 */
function keyIdOf(t) {
  return `${t.key.id}`;
}
const byKey = new Map();
for (const plan of plans) {
  for (const p of plan.strip) {
    const id = keyIdOf(plan.tops.get(p));
    if (!byKey.has(id)) byKey.set(id, new Map());
    const perPlan = byKey.get(id);
    if (!perPlan.has(plan)) perPlan.set(plan, new Set());
    perPlan.get(plan).add(p);
  }
}
const rejected = new Set();
let changedSomething = true;
while (changedSomething) {
  changedSomething = false;
  for (const [id, perPlan] of byKey) {
    const live = [...perPlan.keys()].filter((pl) => !rejected.has(pl));
    const uses = (keyUses.get(id) ?? []).length;
    const sets = new Set(live.map((pl) => [...perPlan.get(pl)].sort().join(",")));
    if (live.length !== uses || sets.size > 1) {
      for (const pl of live) if (!rejected.has(pl)) { rejected.add(pl); changedSomething = true; }
    }
  }
}
for (const plan of plans) {
  if (rejected.has(plan)) continue;
  const { where, tag, m, el, variant, size, variantAttr, sizeAttr, newVariant, newSize, strip, tops } = plan;
  report.push({ where, tag, from: { variant, size }, to: { variant: newVariant ?? variant, size: newSize ?? size }, stripped: [...strip] });
  for (const p of strip) {
    const t = tops.get(p);
    const src = t.key.model.source;
    let end = t.top.getEnd();
    let i = end;
    while (i < src.length && /[ \t]/.test(src[i])) i++;
    if (src[i] === ",") end = i + 1;
    push(t.key.model.file, [t.top.getFullStart(), end, ""]);
  }
  const setAttr = (name, value, existing) => {
    if (existing) push(m.file, [existing.getStart(m.sf), existing.getEnd(), `${name}="${value}"`]);
    else push(m.file, [el.tagName.getEnd(), el.tagName.getEnd(), ` ${name}="${value}"`]);
  };
  if (newVariant && newVariant !== variant && !(newVariant === "default" && !variantAttr)) setAttr("variant", newVariant, variantAttr);
  // An element with no size prop is `default` (2rem); write `md` only where a size was set.
  if (newSize && newSize !== size && !(newSize === "md" && !sizeAttr && tag === "Button")) setAttr("size", newSize, sizeAttr);
}

// Apply: drop duplicate removals, then keys emptied by them are left as `{}`
// (harmless) unless every declaration went, in which case the key is removed
// by a follow-up `codemod.mjs --dead` once its references are gone.
let changed = 0;
for (const [file, list] of edits) {
  const seen = new Set();
  const uniq = list.filter((e) => { const k = `${e[0]}:${e[1]}:${e[2]}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const m = byFile.get(file);
  let out;
  try { out = applyEdits(m.source, uniq); } catch (e) { process.stderr.write(`skip ${file}: ${e.message}\n`); continue; }
  if (out !== m.source) { changed++; if (!DRY) writeFileSync(join(repoRoot, file), out); }
}
if (opt("report")) writeFileSync(opt("report"), JSON.stringify(report, null, 1));
const tally = {};
for (const r of report) { const k = `${r.tag} ${r.from.variant}/${r.from.size} -> ${r.to.variant}/${r.to.size}`; tally[k] = (tally[k] ?? 0) + 1; }
process.stdout.write(`${DRY ? "[dry] " : ""}${changed} file(s); ${report.length} element(s) moved to variant/size\n${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${v}  ${k}`).join("\n")}\n`);
