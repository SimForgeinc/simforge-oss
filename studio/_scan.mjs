
import { transformFileSync } from "@babel/core";
import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stylexBabelConfig } from "./stylex.config.mjs";
const require = createRequire(import.meta.url);
const stylex = require("@stylexjs/stylex");
const CUR = resolve(process.cwd(), "..");
const BASE = "/home/path/tmp/ffaudit/baseline";
const PKG_SRC = resolve(CUR, "packages/studio-ui/src");
const ROOT = process.argv[2] ?? "packages/studio-ui/src";
const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { if (e === "node_modules" || e === "dist") continue; const f = join(dir, e); if (statSync(f).isDirectory()) walk(f, out); else if (/\.tsx$/.test(e)) out.push(f); } return out; };
const varMap = new Map();
for (const f of [join(PKG_SRC, "stylex/tokens.stylex.ts"), resolve(CUR, "packages/studio-ui/dist/stylex/tokens.stylex.js"), join(PKG_SRC, "drive/drive.stylex.ts")]) {
  if (!existsSync(f)) continue;
  const { metadata } = transformFileSync(f, { ...stylexBabelConfig, filename: f });
  for (const [, o] of metadata.stylex ?? []) for (const m of (o.ltr ?? "").matchAll(/--(x[a-z0-9]+):([^;}]+)/g)) varMap.set(`--${m[1]}`, m[2].trim());
}
const deref = (v) => { let o = v; for (let i = 0; i < 5; i++) { const n = o.replace(/var\((--x[a-z0-9]+)\)/g, (w, k) => varMap.get(k) ?? w); if (n === o) break; o = n; } return o; };
const R = (n) => `${n}rem`;
const SP = { "0": "0", "0.5": R(0.125), "1": R(0.25), "1.5": R(0.375), "2": R(0.5), "2.5": R(0.625), "3": R(0.75), "3.5": R(0.875), "4": R(1), "5": R(1.25), "6": R(1.5), "7": R(1.75), "8": R(2), "9": R(2.25), "10": R(2.5), "11": R(2.75), "12": R(3), "14": R(3.5), "16": R(4), "20": R(5), "24": R(6), "px": "1px" };
const FONT = { xs: [R(0.75), R(1)], sm: [R(0.875), R(1.25)], base: [R(1), R(1.5)], lg: [R(1.125), R(1.75)], xl: [R(1.25), R(1.75)], "2xl": [R(1.5), R(2)], "3xl": [R(1.875), R(2.25)] };
const LEAD = { "3": R(0.75), "4": R(1), "5": R(1.25), "6": R(1.5), "7": R(1.75), "8": R(2), none: "1", tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625" };
const TOKENS = ["foreground", "muted-foreground", "background", "border", "card", "popover", "primary", "secondary", "muted", "accent", "destructive", "ring", "input"];
const colorOf = (spec) => { let m;
  if ((m = spec.match(/^(white|black)(?:\/(\[?[\d.]+\]?))?$/))) { const b = m[1] === "white" ? [255,255,255] : [0,0,0]; const raw = m[2]?.replace(/[[\]]/g, ""); const a = raw == null ? 1 : (parseFloat(raw) > 1 ? parseFloat(raw)/100 : parseFloat(raw)); return `rgba(${b.join(",")},${a})`; }
  for (const t of TOKENS) { if (spec === t) return `hsl(var(--${t}))`; if (spec.startsWith(`${t}/`)) { const raw = spec.slice(t.length+1).replace(/[[\]]/g, ""); const a = parseFloat(raw) > 1 ? parseFloat(raw)/100 : parseFloat(raw); return `hsl(var(--${t}) / ${a})`; } }
  if ((m = spec.match(/^\[#([0-9a-fA-F]{3,8})\](?:\/(\[?[\d.]+\]?))?$/))) { let h = m[1]; if (h.length === 3) h = h.split("").map((c)=>c+c).join(""); const [r,g,b] = [0,2,4].map((i)=>parseInt(h.slice(i,i+2),16)); const raw = m[2]?.replace(/[[\]]/g,""); const a = raw == null ? 1 : (parseFloat(raw) > 1 ? parseFloat(raw)/100 : parseFloat(raw)); return `rgba(${r},${g},${b},${a})`; }
  return null; };
const SIDE = { "border-b": "bottom", "border-t": "top", "border-l": "left", "border-r": "right" };
const tw = (t) => { let m;
  const S = { flex:{display:"flex"}, "inline-flex":{display:"inline-flex"}, grid:{display:"grid"}, block:{display:"block"}, "inline-block":{display:"inline-block"}, hidden:{display:"none"}, "flex-col":{"flex-direction":"column"}, "flex-wrap":{"flex-wrap":"wrap"}, "flex-1":{flex:"1 1 0%"}, "shrink-0":{"flex-shrink":"0"}, "min-w-0":{"min-width":"0"}, "mx-auto":{"margin-inline":"auto"}, "tabular-nums":{"font-variant-numeric":"tabular-nums"}, uppercase:{"text-transform":"uppercase"}, capitalize:{"text-transform":"capitalize"}, "font-medium":{"font-weight":"500"}, "font-semibold":{"font-weight":"600"}, "font-bold":{"font-weight":"700"}, truncate:{overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}, "break-all":{"word-break":"break-all"}, "animate-spin":{"animation-name":"SPIN"}, "ml-auto":{"margin-left":"auto"} };
  if (S[t]) return S[t];
  if (SIDE[t]) return { "border-width": "1px" };
  if ((m = t.match(/^items-(start|center|end|baseline|stretch)$/))) return { "align-items": { start:"flex-start", end:"flex-end", center:"center", baseline:"baseline", stretch:"stretch" }[m[1]] };
  if ((m = t.match(/^justify-(start|center|end|between|around)$/))) return { "justify-content": { start:"flex-start", end:"flex-end", center:"center", between:"space-between", around:"space-around" }[m[1]] };
  if ((m = t.match(/^gap-(.+)$/)) && SP[m[1]]) return { gap: SP[m[1]] };
  if ((m = t.match(/^gap-x-(.+)$/)) && SP[m[1]]) return { "column-gap": SP[m[1]] };
  if ((m = t.match(/^gap-y-(.+)$/)) && SP[m[1]]) return { "row-gap": SP[m[1]] };
  if ((m = t.match(/^space-y-(.+)$/)) && SP[m[1]]) return { display:"flex", "flex-direction":"column", gap: SP[m[1]] };
  if ((m = t.match(/^p-(.+)$/)) && SP[m[1]]) return { padding: SP[m[1]], "padding-inline": SP[m[1]], "padding-block": SP[m[1]], "padding-top": SP[m[1]], "padding-left": SP[m[1]] };
  if ((m = t.match(/^px-(.+)$/)) && SP[m[1]]) return { "padding-inline": SP[m[1]], "padding-left": SP[m[1]], "padding-right": SP[m[1]] };
  if ((m = t.match(/^py-(.+)$/)) && SP[m[1]]) return { "padding-block": SP[m[1]], "padding-top": SP[m[1]], "padding-bottom": SP[m[1]] };
  if ((m = t.match(/^pt-(.+)$/)) && SP[m[1]]) return { "padding-top": SP[m[1]] };
  if ((m = t.match(/^pb-(.+)$/)) && SP[m[1]]) return { "padding-bottom": SP[m[1]] };
  if ((m = t.match(/^pl-(.+)$/)) && SP[m[1]]) return { "padding-left": SP[m[1]] };
  if ((m = t.match(/^pr-(.+)$/)) && SP[m[1]]) return { "padding-right": SP[m[1]] };
  if ((m = t.match(/^m([tblr])-(.+)$/)) && SP[m[2]]) return { [`margin-${{t:"top",b:"bottom",l:"left",r:"right"}[m[1]]}`]: SP[m[2]] };
  if ((m = t.match(/^size-(.+)$/)) && SP[m[1]]) return { width: SP[m[1]], height: SP[m[1]] };
  if ((m = t.match(/^w-(.+)$/)) && SP[m[1]]) return { width: SP[m[1]] };
  if ((m = t.match(/^h-(.+)$/)) && SP[m[1]]) return { height: SP[m[1]] };
  if ((m = t.match(/^text-(xs|sm|base|lg|xl|2xl|3xl)$/))) return { "font-size": FONT[m[1]][0], "line-height": FONT[m[1]][1] };
  if ((m = t.match(/^text-\[(\d+)px\]$/))) return { "font-size": `${m[1]}px` };
  if ((m = t.match(/^leading-(.+)$/)) && LEAD[m[1]]) return { "line-height": LEAD[m[1]] };
  if ((m = t.match(/^text-(.+)$/))) { const c = colorOf(m[1]); if (c) return { color: c }; }
  if ((m = t.match(/^bg-(.+)$/))) { const c = colorOf(m[1]); if (c) return { "background-color": c }; }
  if ((m = t.match(/^border-(.+)$/))) { const c = colorOf(m[1]); if (c) return { "border-color": c }; }
  if (t === "border") return { "border-width": "1px" };
  return null; };
const expected = (cls) => { const decls = {}; const unmapped = [];
  const tokens = cls.split(/\s+/).filter(Boolean);
  const sides = tokens.filter((t) => SIDE[t]).map((t) => SIDE[t]);
  const sided = sides.length > 0 && !tokens.includes("border");
  for (const t of tokens) { if (/^(sm|md|lg|xl|2xl|hover|focus|focus-visible|active|disabled|group|data-|aria-|peer|dark|first|last|odd|even|motion-safe|motion-reduce|has):/.test(t) || t.startsWith("[&")) { unmapped.push(t); continue; } const d = tw(t); if (!d) { unmapped.push(t); continue; } Object.assign(decls, d); }
  if (sided && decls["border-color"] !== undefined) { for (const s of sides) decls[`border-${s}-color`] = decls["border-color"]; delete decls["border-color"]; }
  if (sided && decls["border-width"] !== undefined) { for (const s of sides) decls[`border-${s}-width`] = decls["border-width"]; delete decls["border-width"]; }
  return { decls, unmapped }; };
const ruleCache = new Map(); const modCache = new Map();
const compileModule = (file) => { if (modCache.has(file)) return modCache.get(file); let out = null;
  try { const { code, metadata } = transformFileSync(file, { ...stylexBabelConfig, filename: file });
    for (const [k, o] of metadata.stylex ?? []) ruleCache.set(k, o.ltr);
    const body = code.replace(/^import[^\n]*\n/gm, "").replace(/export const /g, "const ").replace(/export \{[^}]*\};?/g, "");
    const names = [...code.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
    const prelude = ["colors","text","space","radii","layers","motion","driveColors","driveText","editorColors"].map((n) => `const ${n} = new Proxy({}, { get: () => "stub" });`).join("\n");
    out = new Function("stylex", `${prelude}\n${body}\nreturn { ${names.join(", ")} };`)(stylex); } catch { out = null; }
  modCache.set(file, out); return out; };
const resolveSpec = (from, spec) => { let base;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@simforge-oss/studio-ui/")) base = join(PKG_SRC, spec.slice(24));
  else if (spec.startsWith("@/")) base = resolve(CUR, "studio", spec.slice(2));
  else return null;
  for (const ext of [".ts", ".tsx"]) if (existsSync(base + ext)) return base + ext;
  return null; };
const extractCalls = (src) => { const calls = []; const needle = "stylex.props("; let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) { let depth = 0, j = i + needle.length - 1;
    for (; j < src.length; j++) { if (src[j] === "(") depth++; else if (src[j] === ")") { depth--; if (depth === 0) break; } }
    calls.push({ a: src.slice(i + needle.length, j), line: src.slice(0, i).split("\n").length }); i = j + 1; }
  return calls; };
const splitTop = (s) => { const out = []; let d = 0, last = 0;
  for (let i = 0; i < s.length; i++) { const c = s[i]; if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--; else if (c === "," && d === 0) { out.push(s.slice(last, i)); last = i + 1; } }
  out.push(s.slice(last)); return out.map((x) => x.trim()).filter(Boolean); };
const canon = (v) => { let s = String(v).trim().toLowerCase().replace(/\bwhite\b/g, "rgba(255,255,255,1)").replace(/\bblack\b/g, "rgba(0,0,0,1)");
  const m = s.match(/^(?:rgba?|hsla?)\(\s*([\d.]+)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) { let a = m[4] ?? "1"; if (a.endsWith("%")) a = String(parseFloat(a)/100); return `${s.startsWith("hsl") ? "hsl" : "rgb"}(${parseFloat(m[1])},${m[2]},${m[3]},${parseFloat(a)})`; }
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) { const h = hex[1].length === 3 ? hex[1].split("").map((c)=>c+c).join("") : hex[1]; return `rgb(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},1)`; }
  s = s.replace(/\s+/g, "").replace(/^0px$/, "0").replace(/^\.(\d)/, "0.$1").replace(/\/\.(\d)/g, "/0.$1").replace(/,\.(\d)/g, ",0.$1");
  const n = s.match(/^([\d.]+)rem$/); if (n) return `${parseFloat(n[1])}rem`;
  return s; };
const same = (a, b) => canon(a) === canon(b) || b === "SPIN" || (b === "1 1 0%" && ["1", "11 0%"].includes(canon(a)));
const declsOf = (objs) => { const className = objs.length ? (stylex.props(...objs).className ?? "") : ""; const d = {};
  for (const c of className.split(" ").filter(Boolean)) { const rule = ruleCache.get(c) ?? "";
    if (/:hover|:focus|:disabled|::|@media|:first-child|:last-child|:not/.test(rule)) continue;
    const m = rule.match(/\{([-a-z]+):(.*)\}$/); if (m) d[m[1]] = deref(m[2]); }
  for (const box of ["padding", "margin"]) { const all = d[box];
    if (all !== undefined) { const p = all.split(/\s+/); const [t, r2, b2, l] = p.length === 1 ? [p[0],p[0],p[0],p[0]] : p.length === 2 ? [p[0],p[1],p[0],p[1]] : p.length === 3 ? [p[0],p[1],p[2],p[1]] : p;
      d[`${box}-top`] ??= t; d[`${box}-right`] ??= r2; d[`${box}-bottom`] ??= b2; d[`${box}-left`] ??= l; }
    if (d[`${box}-inline`] !== undefined) { d[`${box}-left`] ??= d[`${box}-inline`]; d[`${box}-right`] ??= d[`${box}-inline`]; }
    if (d[`${box}-block`] !== undefined) { d[`${box}-top`] ??= d[`${box}-block`]; d[`${box}-bottom`] ??= d[`${box}-block`]; }
    if (d[`${box}-inline-end`] !== undefined) d[`${box}-right`] ??= d[`${box}-inline-end`];
    if (d[`${box}-inline-start`] !== undefined) d[`${box}-left`] ??= d[`${box}-inline-start`];
    if (d[`${box}-left`] !== undefined && canon(d[`${box}-left`]) === canon(d[`${box}-right`] ?? "")) d[`${box}-inline`] ??= d[`${box}-left`];
    if (d[`${box}-top`] !== undefined && canon(d[`${box}-top`]) === canon(d[`${box}-bottom`] ?? "")) d[`${box}-block`] ??= d[`${box}-top`]; }
  if (d["border-color"] !== undefined) for (const s of ["top","right","bottom","left"]) d[`border-${s}-color`] ??= d["border-color"];
  if (d["border-width"] !== undefined) for (const s of ["top","right","bottom","left"]) d[`border-${s}-width`] ??= d["border-width"];
  return d; };
const WATCH = ["flex-shrink","display","flex-wrap","gap","column-gap","row-gap","align-items","justify-content","flex-direction","text-transform","font-variant-numeric","animation-name","margin-top","margin-bottom","margin-left","margin-right","padding-inline","padding-block","width","height","line-height","font-size","color","background-color"];
for (const file of walk(join(CUR, ROOT))) {
  const rel = file.slice(CUR.length + 1);
  const baseFile = join(BASE, rel); if (!existsSync(baseFile)) continue;
  const baseSrc = readFileSync(baseFile, "utf8"); const curSrc = readFileSync(file, "utf8");
  const baseClasses = [...baseSrc.matchAll(/className=\{?\s*(?:cn\()?\s*"([^"]+)"/g)].map((m) => ({ s: m[1], line: baseSrc.slice(0, m.index).split("\n").length }));
  const calls = extractCalls(curSrc);
  if (!baseClasses.length || !calls.length) continue;
  const aliases = new Map();
  for (const m of curSrc.matchAll(/import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/g)) { const target = resolveSpec(file, m[2]); if (!target) continue;
    for (const part of m[1].split(",")) { const b = part.trim().split(/\s+as\s+/); if (b[0]) aliases.set((b[1] ?? b[0]).trim(), { target, exported: b[0].trim() }); } }
  const memo = new Map();
  const score = (i, j) => { const k = `${i}:${j}`; if (memo.has(k)) return memo.get(k);
    const e = expected(baseClasses[i].s); let objs = []; let unresolved = false;
    for (const arg of splitTop(calls[j].a)) { const keys = [...arg.matchAll(/\b(\w+)\.(\w+)\b/g)].filter((m) => aliases.has(m[1]));
      if (!keys.length && /\w/.test(arg)) unresolved = true;
      for (const m of keys) { const al = aliases.get(m[1]); const obj = compileModule(al.target)?.[al.exported]?.[m[2]]; if (obj) objs.push(obj); } }
    const a = declsOf(objs); const keys = Object.keys(e.decls); let hit = 0; const diffs = [];
    for (const [p, v] of Object.entries(e.decls)) { if (p in a && same(a[p], v)) hit++; else if (!(p in a)) diffs.push(`missing ${p}: ${v}`); else diffs.push(`${p}: ${a[p]} (baseline ${v})`); }
    if (e.unmapped.length === 0 && !unresolved) { const eBorder = Object.keys(e.decls).some((p) => /^border(-\w+)?-color$/.test(p));
      for (const p of WATCH) { if (!(p in a) || p in e.decls) continue; if (/^border(-\w+)?-(color|width)$/.test(p) && eBorder) continue; diffs.push(`EXTRA ${p}: ${a[p]}`); } }
    const r = { s: keys.length ? hit / keys.length : 0.2, diffs: objs.length ? diffs : [] }; memo.set(k, r); return r; };
  const B = baseClasses.length, C = calls.length;
  const dp = Array.from({ length: B + 1 }, () => new Float64Array(C + 1));
  const back = Array.from({ length: B + 1 }, () => new Int8Array(C + 1));
  for (let i = B - 1; i >= 0; i--) for (let j = C - 1; j >= 0; j--) { const pair = score(i, j).s + dp[i+1][j+1], sb = dp[i+1][j] - 0.05, sc = dp[i][j+1] - 0.05;
    const best = Math.max(pair, sb, sc); dp[i][j] = best; back[i][j] = best === pair ? 0 : best === sb ? 1 : 2; }
  const out = [];
  for (let i = 0, j = 0; i < B && j < C;) { if (back[i][j] === 0) { const r = score(i, j);
      if (r.s >= 0.5 && r.diffs.length) out.push(`  L${calls[j].line} <- base L${baseClasses[i].line} "${baseClasses[i].s.slice(0, 80)}"\n     ${r.diffs.join("\n     ")}`);
      i++; j++; } else if (back[i][j] === 1) i++; else j++; }
  if (out.length) console.log(`\n## ${rel}\n${out.join("\n")}`);
}
