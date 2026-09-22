/**
 * Source model for the style codemod: every `stylex.create` namespace with
 * its declarations, their condition paths and exact source ranges, plus every
 * place a namespace is referenced (`styles.key`) in its own file or an
 * importer. The transforms in `codemod.mjs` edit source text by range, so a
 * file keeps its formatting and comments.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { listStyleSources } from "./ratchet-lib.mjs";

const require = createRequire(import.meta.url);
export const ts = require("typescript");

export function parse(fileName, source) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Static value of a literal-ish expression, following local consts. */
export function staticValue(node, consts, depth = 0) {
  if (!node || depth > 5) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) return staticValue(node.expression, consts, depth);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && consts.has(node.text)) return staticValue(consts.get(node.text), consts, depth + 1);
  return undefined;
}

function keyName(name, sf, consts) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const v = consts ? staticValue(name.expression, consts) : undefined;
    return typeof v === "string" ? v : `[${name.expression.getText(sf)}]`;
  }
  return name.getText(sf);
}

/**
 * Analyse one file. Returns imports, top-level consts, stylex bindings and
 * the namespaces of every `stylex.create` call.
 */
export function modelFile(file, source) {
  const sf = parse(file, source);
  const imports = new Map(); // local -> { spec, imported, node }
  const importDecls = [];
  const reexports = []; // { exported, imported, spec } ; imported "*" for `export * from`
  const consts = new Map();
  const constDecls = new Map();
  let stylexNs = null;
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (!st.exportClause) reexports.push({ exported: "*", imported: "*", spec });
      else if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) reexports.push({ exported: el.name.text, imported: (el.propertyName ?? el.name).text, spec });
    }
    if (ts.isImportDeclaration(st)) {
      importDecls.push(st);
      const spec = st.moduleSpecifier.text;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        imports.set(nb.name.text, { spec, imported: "*", node: st });
        if (spec === "@stylexjs/stylex") stylexNs = nb.name.text;
      }
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.set(el.name.text, { spec, imported: (el.propertyName ?? el.name).text, node: st });
    }
  }
  (function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      consts.set(node.name.text, node.initializer);
      constDecls.set(node.name.text, node);
    }
    ts.forEachChild(node, collect);
  })(sf);

  const creates = [];
  (function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === stylexNs && node.expression.name.text === "create") {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        let binding = null;
        let exported = false;
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          binding = node.parent.name.text;
          const stmt = node.parent.parent?.parent;
          exported = Boolean(stmt && ts.canHaveModifiers?.(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        }
        const namespaces = [];
        for (const member of arg.properties) {
          if (!ts.isPropertyAssignment(member)) {
            namespaces.push({ key: member.name ? keyName(member.name, sf) : "?", member, dynamic: true, decls: [], unsupported: true });
            continue;
          }
          const key = keyName(member.name, sf);
          let body = member.initializer;
          const dynamic = ts.isArrowFunction(body) || ts.isFunctionExpression(body);
          const ns = { key, member, dynamic, decls: [], unsupported: false, object: null };
          if (!dynamic && ts.isObjectLiteralExpression(body)) {
            ns.object = body;
            walkStyle(body, [], null, ns, sf, consts);
          } else {
            ns.unsupported = true;
          }
          namespaces.push(ns);
        }
        creates.push({ call: node, binding, exported, namespaces });
      }
    }
    ts.forEachChild(node, visit);
  })(sf);
  return { file, source, sf, imports, importDecls, reexports, consts, constDecls, stylexNs, creates };
}

/**
 * Flatten a style object into declarations. A declaration is one leaf value:
 * `{ prop, conds: [...], valueNode, member }`. `member` is the property
 * assignment whose initializer is the leaf, so its range can be replaced or
 * deleted. `top` is the top-level property assignment the leaf belongs to.
 */
function walkStyle(object, conds, prop, ns, sf, consts, top = null) {
  for (const member of object.properties) {
    if (ts.isSpreadAssignment(member)) {
      ns.unsupported = true;
      continue;
    }
    if (!ts.isPropertyAssignment(member)) {
      ns.unsupported = true;
      continue;
    }
    const key = keyName(member.name, sf, consts);
    const init = member.initializer;
    const isCond = prop !== null || /^[:@[]/.test(key) || key === "default";
    const nextTop = top ?? member;
    if (ts.isObjectLiteralExpression(init)) {
      if (prop === null && !isCond) walkStyle(init, conds, key, ns, sf, consts, nextTop);
      else walkStyle(init, [...conds, key], prop, ns, sf, consts, nextTop);
      continue;
    }
    const p = prop ?? key;
    const c = prop === null ? conds : [...conds, key];
    ns.decls.push({ prop: p, conds: c.filter((k) => k !== "default"), rawConds: c, valueNode: init, member, top: nextTop, value: staticValue(init, consts) });
  }
}

/** Canonical text of a declaration set, for exact-duplicate matching. */
export function signature(decls, normalize = (v) => v) {
  return decls
    .map((d) => `${d.prop}|${d.rawConds.join(">")}|${normalize(d.value, d)}`)
    .sort()
    .join(";");
}

/** Resolve a relative/alias import specifier to a repository file. */
export function resolveSpecifier(fromFile, spec, repoRoot) {
  let base;
  if (spec.startsWith(".")) base = resolve(repoRoot, dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = join(repoRoot, "studio", spec.slice(2));
  else if (spec.startsWith("@simforge-oss/studio-ui/")) base = join(repoRoot, "packages/studio-ui/src", spec.slice("@simforge-oss/studio-ui/".length));
  else if (spec === "@simforge-oss/studio-ui") base = join(repoRoot, "packages/studio-ui/src/index");
  else return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const candidate = base + ext;
    try {
      readFileSync(candidate);
      return relative(repoRoot, candidate).split(sep).join("/");
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Every reference to an exported/created style binding: `binding.key` in the
 * defining file, and `local.key` in importers (named or namespace imports).
 * Returns Map<"file#binding", { defining, refs: [{ file, node, key }], computed }>.
 */
export function collectReferences(models, repoRoot) {
  const byFile = new Map(models.map((m) => [m.file, m]));
  const refs = new Map();
  const ensure = (file, binding) => {
    const id = `${file}#${binding}`;
    if (!refs.has(id)) refs.set(id, { file, binding, refs: [], computed: false, escapes: false });
    return refs.get(id);
  };
  for (const m of models) for (const c of m.creates) if (c.binding) ensure(m.file, c.binding);

  /** Follow `export { x } from` / `export * from` chains to the defining binding. */
  const resolveExport = (file, name, depth = 0) => {
    if (refs.has(`${file}#${name}`)) return `${file}#${name}`;
    const m = byFile.get(file);
    if (!m || depth > 6) return null;
    for (const re of m.reexports) {
      const target = resolveSpecifier(file, re.spec, repoRoot);
      if (!target) continue;
      if (re.exported === name) {
        const hit = resolveExport(target, re.imported, depth + 1);
        if (hit) return hit;
      }
      if (re.exported === "*") {
        const hit = resolveExport(target, name, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  for (const m of models) {
    // local name -> id of the style binding it denotes
    const local = new Map();
    for (const c of m.creates) if (c.binding) local.set(c.binding, `${m.file}#${c.binding}`);
    const nsImports = new Map();
    for (const [name, imp] of m.imports) {
      const target = resolveSpecifier(m.file, imp.spec, repoRoot);
      if (!target) continue;
      if (imp.imported === "*") { if (byFile.has(target)) nsImports.set(name, target); }
      else {
        const id = resolveExport(target, imp.imported);
        if (id) local.set(name, id);
      }
    }
    // A re-export is a use of the whole binding: it may be read anywhere.
    for (const re of m.reexports) {
      const target = resolveSpecifier(m.file, re.spec, repoRoot);
      if (!target || re.exported === "*") continue;
      const id = resolveExport(target, re.imported);
      if (id) refs.get(id).reexported = true;
    }
    (function visit(node) {
      if (ts.isPropertyAccessExpression(node)) {
        let root = node.expression;
        let id = null;
        if (ts.isIdentifier(root) && local.has(root.text)) id = local.get(root.text);
        else if (ts.isPropertyAccessExpression(root) && ts.isIdentifier(root.expression) && nsImports.has(root.expression.text)) {
          const cand = `${nsImports.get(root.expression.text)}#${root.name.text}`;
          if (refs.has(cand)) id = cand;
        }
        if (id) {
          refs.get(id).refs.push({ file: m.file, node, key: node.name.text });
          return;
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && local.has(node.expression.text)) {
        refs.get(local.get(node.expression.text)).computed = true;
      }
      if (ts.isIdentifier(node) && local.has(node.text)) {
        const parent = node.parent;
        const isAccess = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
        const isDecl = ts.isVariableDeclaration(parent) && parent.name === node;
        const isImport = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
        if (!isAccess && !isDecl && !isImport) refs.get(local.get(node.text)).escapes = true;
        if (ts.isExportSpecifier(parent)) refs.get(local.get(node.text)).escapes = true;
      }
      ts.forEachChild(node, visit);
    })(m.sf);
  }
  return refs;
}

export function loadModels(repoRoot) {
  const models = [];
  for (const file of listStyleSources(repoRoot)) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    if (!source.includes("@stylexjs/stylex") && !source.includes(".stylex")) continue;
    models.push(modelFile(file, source));
  }
  return models;
}

/** Apply non-overlapping [start, end, text] edits to a string. */
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let out = source;
  let last = Infinity;
  for (const [start, end, text] of sorted) {
    if (end > last) throw new Error(`overlapping edits at ${start}-${end}`);
    out = out.slice(0, start) + text + out.slice(end);
    last = start;
  }
  return out;
}
