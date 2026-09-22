#!/usr/bin/env node
/**
 * Studio style codemod. Every transform keeps the rendered value identical:
 *
 *   --tokens    raw literal -> the token with the same value and a matching
 *               role (a 0.08-white border becomes `colors.hairline`, never a
 *               fill that happens to share the alpha); literal breakpoints ->
 *               `[layout.bp*]`; local consts holding a token's value are
 *               inlined as the token.
 *   --aliases   deprecated token names -> their canonical names.
 *   --recipes   inline copies of a recipe (sr-only, truncate, the focus
 *               rings, colour/transform transitions, spin/pulse) are removed
 *               from the style key and the recipe is composed in front of the
 *               key at every reference: `styles.x` -> `[focus.ring, styles.x]`,
 *               or just the recipe when nothing else was left in the key.
 *   --dead      style keys nothing references, and modules nothing imports.
 *   --radii     radius declarations, which the global reset makes inert.
 *
 * Usage: node scripts/style/codemod.mjs [--tokens] [--aliases] [--recipes]
 *        [--dead] [--radii] [--all] [--dry] [--exclude-file list.txt]
 *        [--only path-substring]
 *
 * It edits source text by range, so formatting and comments survive; run the
 * formatter-free diff through review like any change. Re-run it after a
 * rebase: it is idempotent.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, collectReferences, loadModels, modelFile, resolveSpecifier, staticValue, ts } from "./codemod-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`) || (argv.includes("--all") && !VISUAL.has(name));
/** Transforms that change what renders; never part of --all. */
const VISUAL = new Set(["collapse", "roles", "empty"]);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const DRY = argv.includes("--dry");
const ONLY = opt("only");

// ---------------------------------------------------------------------------
// Exclusions: files other work owns right now, plus anything listed in a file.
const excludeGlobs = [];
const excludeFile = opt("exclude-file");
if (excludeFile) {
  for (const line of readFileSync(excludeFile, "utf8").split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) excludeGlobs.push(t);
  }
}
const globToRe = (g) =>
  new RegExp(
    "^" +
      g
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0001")
        .replace(/\*\*/g, "\u0002")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0001/g, "(?:.*/)?")
        .replace(/\u0002/g, ".*") +
      "$",
  );
const excludeRes = excludeGlobs.map(globToRe);
const FOUNDATION = /^packages\/studio-ui\/src\/stylex\//;
/** Sources the desktop shell pages compile without the global stylesheet. */
const DESKTOP_SHELL = /^packages\/studio-ui\/src\/components\/(CloudLoadingSurface|SkyCloudBackdrop)\.stylex\.ts$/;
const isExcluded = (file) => FOUNDATION.test(file) || excludeRes.some((re) => re.test(file)) || (ONLY && !file.includes(ONLY));

// ---------------------------------------------------------------------------
// Token table, parsed from the token module so it never drifts.
const tokenSource = readFileSync(join(repoRoot, "packages/studio-ui/src/stylex/tokens.stylex.ts"), "utf8");
const TOKENS = [];
{
  const sf = ts.createSourceFile("tokens.ts", tokenSource, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const call = d.initializer;
      if (!call || !ts.isCallExpression(call) || !ts.isObjectLiteralExpression(call.arguments[0] ?? {})) continue;
      const group = d.name.getText(sf);
      for (const p of call.arguments[0].properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const name = p.name.getText(sf);
        const jsDoc = ts.getJSDocTags(p).some((t) => t.tagName.text === "deprecated") || /@deprecated/.test(sf.text.slice(p.getFullStart(), p.getStart()));
        const value = staticValue(p.initializer, new Map());
        if (value === undefined) continue;
        TOKENS.push({ group, name, ref: `${group}.${name}`, value, deprecated: jsDoc });
      }
    }
  }
}
const tokenByRef = new Map(TOKENS.map((t) => [t.ref, t]));

// ---------------------------------------------------------------------------
// Value normalisation.
function normColor(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "white") return "rgba(255,255,255,1)";
  if (s === "black") return "rgba(0,0,0,1)";
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const a = h.length === 8 ? +(parseInt(h.slice(6, 8), 16) / 255).toFixed(3) : 1;
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return `rgba(${+m[1]},${+m[2]},${+m[3]},${+a.toFixed(3)})`;
  }
  m = s.match(/^hsl\(var\((--[\w-]+)\)\s*(?:\/\s*([\d.]+%?))?\s*\)$/);
  if (m) return `hsl(${m[1]}${m[2] === undefined ? "" : `/${m[2].endsWith("%") ? parseFloat(m[2]) / 100 : +m[2]}`})`;
  return null;
}
/** Colours inside a compound value (shadows, gradients) in canonical form. */
function normCompound(v) {
  if (typeof v !== "string") return String(v);
  return v
    .toLowerCase()
    .replace(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|hsl\(var\(--[\w-]+\)(?:\s*\/\s*[\d.]+%?)?\)/g, (c) => normColor(c) ?? c)
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}
function sameLength(a, b) {
  const re = /^(-?\d*\.?\d+)(px|rem|em|ms|s|%)?$/;
  const x = String(a).trim().match(re);
  const y = String(b).trim().match(re);
  if (!x || !y) return false;
  const [xv, xu = ""] = [parseFloat(x[1]), x[2]];
  const [yv, yu = ""] = [parseFloat(y[1]), y[2]];
  if ((xu === "ms" || xu === "s") && (yu === "ms" || yu === "s")) return (xu === "s" ? xv * 1000 : xv) === (yu === "s" ? yv * 1000 : yv);
  return (xu ?? "") === (yu ?? "") && xv === yv;
}

// ---------------------------------------------------------------------------
// Which token families may stand in for a literal in which property.
const COLOR_CLASS = (prop) => {
  if (/^(color|caretColor|textDecorationColor|WebkitTextFillColor)$/.test(prop)) return "text";
  if (/^(border(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?Color|outlineColor|columnRuleColor)$/.test(prop)) return "border";
  if (/^backgroundColor$/.test(prop)) return "bg";
  if (/^(fill|stroke|stopColor|floodColor|lightingColor)$/.test(prop)) return "paint";
  return null;
};
const FAMILY = {
  text: /^(ink(Secondary|Muted|Faint|Ghost)?|text|mutedForeground|accent|accentText|primary|primaryForeground|secondaryForeground|danger|dangerText|positive|warning|critical|info|signal\w+|hoverWashText)$/,
  border: /^(hairline(Subtle|Strong)?|border|input|ring|accent|accentLine(Subtle)?|positive|warning|critical|info|danger|primary|signal\w+)$/,
  bg: /^(fill(Faint|Subtle|Strong|Stronger)?|glassRaised|scrim(Light|Heavy)?|accent|accentWash|\w+Wash|bg|card|popover|muted|secondary|primary|danger|panel(Solid|2)?|surface(Deep|Raised)|hoverWash|border|input|signal\w+)$/,
  paint: /.*/,
};
function categoryOf(prop) {
  if (COLOR_CLASS(prop)) return "color";
  if (/^(padding|margin|inset|scrollMargin|scrollPadding)(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?$|^(gap|rowGap|columnGap)$/.test(prop)) return "space";
  if (prop === "fontSize") return "fontSize";
  if (prop === "lineHeight") return "lineHeight";
  if (prop === "letterSpacing") return "tracking";
  if (prop === "fontWeight") return "weight";
  if (prop === "fontFamily") return "font";
  if (/^border(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?Width$|^outlineWidth$/.test(prop)) return "stroke";
  if (prop === "boxShadow") return "shadow";
  if (prop === "zIndex") return "layer";
  if (/^(transition|animation)(Duration|Delay)$/.test(prop)) return "duration";
  if (/^(transition|animation)TimingFunction$/.test(prop)) return "easing";
  if (/^(backdropFilter|WebkitBackdropFilter|filter)$/.test(prop)) return "blur";
  return null;
}
const NEUTRAL = new Set(["0", "0px", "0s", "0ms", "none", "transparent", "inherit", "initial", "unset", "currentcolor", "auto", "normal", "100%", ""]);

function findToken(prop, value) {
  const cat = categoryOf(prop);
  if (!cat || value === null || value === undefined) return null;
  if (NEUTRAL.has(String(value).trim().toLowerCase())) return null;
  const live = TOKENS.filter((t) => !t.deprecated);
  const pick = (cands) => cands[0] ?? null;
  switch (cat) {
    case "color": {
      const n = normColor(value);
      if (!n) return null;
      const cls = COLOR_CLASS(prop);
      return pick(live.filter((t) => t.group === "colors" && FAMILY[cls].test(t.name) && normColor(t.value) === n));
    }
    case "space":
      if (typeof value === "number" || String(value).trim().startsWith("-")) return null;
      return pick(live.filter((t) => t.group === "space" && /^s\d/.test(t.name) && sameLength(t.value, value)));
    case "fontSize":
      return pick(live.filter((t) => t.group === "text" && t.name.startsWith("size") && sameLength(t.value, value)));
    case "lineHeight":
      return pick(live.filter((t) => t.group === "text" && t.name.startsWith("line") && (sameLength(t.value, value) || String(t.value) === String(value))));
    case "tracking":
      return pick(live.filter((t) => t.group === "text" && t.name.startsWith("tracking") && sameLength(t.value, value)));
    case "weight":
      return pick(live.filter((t) => t.group === "text" && t.name.startsWith("weight") && String(t.value) === String(value)));
    case "font":
      return pick(live.filter((t) => t.group === "text" && t.name.startsWith("font") && normCompound(t.value) === normCompound(value)));
    case "stroke": {
      const v = typeof value === "number" ? `${value}px` : value;
      return pick(live.filter((t) => t.group === "stroke" && sameLength(t.value, v)));
    }
    case "shadow":
      return pick(live.filter((t) => t.group === "shadows" && normCompound(t.value) === normCompound(value)));
    case "layer":
      if (typeof value !== "number") return null;
      return pick(live.filter((t) => t.group === "layers" && t.value === value));
    case "duration": {
      const cands = live.filter((t) => t.group === "motion" && t.name.startsWith("dur") && sameLength(t.value, value));
      return pick(cands.filter((t) => (t.name === "durSpin" || t.name === "durPulse" ? prop === "animationDuration" : true)));
    }
    case "easing":
      return pick(live.filter((t) => t.group === "motion" && t.name.startsWith("ease") && normCompound(t.value) === normCompound(value)));
    case "blur":
      return pick(live.filter((t) => t.group === "motion" && t.name.startsWith("blur") && normCompound(t.value) === normCompound(value)));
  }
  return null;
}
// ---------------------------------------------------------------------------
// --collapse: the visual step. A literal with no exact token moves to the
// nearest step of the ladder for its role. This changes what renders, by
// design: 40 white alphas become five ink steps, three hairlines, five fills.
function rgbaOf(v) {
  const n = normColor(v);
  if (!n) return null;
  const m = n.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: +m[4] };
  const t = n.match(/^hsl\((--[\w-]+)(?:\/([\d.]+))?\)$/);
  if (t) return { theme: t[1], a: t[2] === undefined ? 1 : +t[2] };
  return null;
}
const near = (x, y, tol = 24) => Math.abs(x - y) <= tol;
const HUES = {
  critical: [[252, 165, 165], [248, 113, 113], [239, 68, 68], [254, 202, 202], [220, 38, 38], [244, 63, 94], [251, 113, 133], [253, 164, 175]],
  positive: [[52, 211, 153], [74, 222, 128], [34, 197, 94], [16, 185, 129], [110, 231, 183], [134, 239, 172]],
  warning: [[252, 211, 77], [251, 191, 36], [245, 158, 11], [253, 230, 138], [254, 243, 199], [250, 204, 21], [253, 224, 71], [217, 119, 6]],
  info: [[125, 211, 252], [56, 189, 248], [96, 165, 250], [147, 197, 253], [14, 165, 233]],
};
const tok = (ref) => tokenByRef.get(ref) ?? null;
function inkStep(a) {
  if (a >= 0.85) return "colors.ink";
  if (a >= 0.58) return "colors.inkSecondary";
  if (a >= 0.4) return "colors.inkMuted";
  if (a >= 0.3) return "colors.inkFaint";
  return "colors.inkGhost";
}
function collapseColor(prop, value) {
  const cls = COLOR_CLASS(prop);
  const c = rgbaOf(value);
  if (!cls || !c) return null;
  const white = c.theme === "--foreground" || (c.r === 255 && c.g === 255 && c.b === 255) || (c.r >= 237 && c.r === c.g && c.g === c.b);
  const black = !c.theme && c.r <= 12 && c.g <= 12 && c.b <= 12;
  const accent = c.theme === "--primary" || (!c.theme && near(c.r, 232, 10) && near(c.g, 224, 10) && near(c.b, 68, 20));
  if (white) {
    if (cls === "text" || cls === "paint") return inkStep(c.a);
    if (cls === "border") return c.a <= 0.06 ? "colors.hairlineSubtle" : c.a <= 0.11 ? "colors.hairline" : "colors.hairlineStrong";
    if (cls === "bg" && c.a <= 0.2) return c.a <= 0.03 ? "colors.fillFaint" : c.a <= 0.05 ? "colors.fillSubtle" : c.a <= 0.08 ? "colors.fill" : c.a <= 0.12 ? "colors.fillStrong" : "colors.fillStronger";
    return null;
  }
  if (black) {
    if (cls === "bg" && c.a >= 0.2 && c.a < 0.95) return c.a <= 0.35 ? "colors.scrimLight" : c.a <= 0.6 ? "colors.scrim" : "colors.scrimHeavy";
    return null;
  }
  if (accent) {
    if (cls === "text" || cls === "paint") return "colors.accent";
    if (cls === "border") return c.a >= 0.5 ? "colors.accentLine" : "colors.accentLineSubtle";
    if (cls === "bg") return c.a <= 0.2 ? "colors.accentWash" : c.a >= 0.9 ? "colors.accent" : null;
    return null;
  }
  if (c.theme === "--muted" && cls === "bg") return c.a <= 0.3 ? "colors.fillFaint" : c.a <= 0.6 ? "colors.fillSubtle" : "colors.fill";
  if (c.theme === "--border" && (cls === "border" || cls === "bg")) return "colors.hairline";
  if (c.theme === "--muted-foreground" && (cls === "text" || cls === "paint")) return c.a >= 0.8 ? "colors.inkMuted" : "colors.inkFaint";
  if (c.theme === "--destructive") return cls === "bg" ? "colors.criticalWash" : "colors.critical";
  if (c.theme) return null;
  for (const [role, list] of Object.entries(HUES)) {
    if (list.some(([r, g, b]) => near(c.r, r, 8) && near(c.g, g, 8) && near(c.b, b, 8))) {
      if (cls === "bg") return c.a <= 0.3 ? `colors.${role}Wash` : null;
      return `colors.${role}`;
    }
  }
  return null;
}
function collapseToken(prop, value) {
  if (value === null || value === undefined) return null;
  const cat = categoryOf(prop);
  let ref = null;
  if (cat === "color") ref = collapseColor(prop, value);
  else if (cat === "fontSize") {
    const px = String(value).trim().match(/^(\d+(?:\.\d+)?)px$/);
    if (px) ref = { 8: "text.sizeNano", 9: "text.sizeTag", 10: "text.sizeMicro", 11: "text.sizeMeta", 12: "text.sizeXs", 13: "text.sizeXs", 14: "text.sizeSm", 16: "text.sizeBase", 18: "text.sizeLg", 20: "text.sizeXl", 24: "text.size2xl" }[+px[1]] ?? null;
  } else if (cat === "duration") {
    const ms = String(value).trim().match(/^(\d*\.?\d+)(ms|s)$/);
    if (ms) {
      const v = ms[2] === "s" ? +ms[1] * 1000 : +ms[1];
      ref = v >= 70 && v <= 100 ? "motion.durInstant" : v <= 130 && v > 100 ? "motion.durFast" : v >= 140 && v <= 160 ? "motion.durStandard" : v >= 170 && v <= 220 ? "motion.durBase" : v >= 240 && v <= 320 ? "motion.durSlow" : null;
    }
  } else if (cat === "blur") {
    const b = String(value).trim().match(/^blur\((\d+)px\)$/);
    if (b) {
      const v = +b[1];
      ref = v <= 5 ? "motion.blurSm" : v <= 10 ? "motion.blurMd" : v <= 16 ? "motion.blurGlass" : v <= 30 ? "motion.blurPane" : "motion.blurLg";
    }
  } else if (cat === "space") {
    const px = String(value).trim().match(/^(\d+(?:\.\d+)?)px$/);
    if (px) {
      const rem = +px[1] / 16;
      ref = TOKENS.find((t) => t.group === "space" && /^s\d/.test(t.name) && !t.deprecated && parseFloat(t.value) === rem)?.ref ?? null;
    }
  } else if (cat === "tracking") {
    const em = String(value).trim().match(/^(-?\d*\.?\d+)em$/);
    if (em) {
      const v = +em[1];
      ref = v < -0.01 ? "text.trackingTight" : v > 0.01 && v <= 0.035 ? "text.trackingWide" : v > 0.035 && v <= 0.065 ? "text.trackingWider" : v > 0.065 && v <= 0.11 ? "text.trackingMetaNarrow" : v > 0.11 && v <= 0.13 ? "text.trackingMetaTight" : v > 0.13 && v <= 0.15 ? "text.trackingMeta" : v > 0.15 && v <= 0.17 ? "text.trackingMetaWide" : v > 0.17 && v <= 0.2 ? "text.trackingMetaWider" : v > 0.2 && v <= 0.25 ? "text.trackingMetaWidest" : null;
    }
  }
  return ref ? tok(ref) : null;
}
/** Deprecated or off-ladder token names that --collapse moves onto a ladder step. */
const COLLAPSE_ALIASES = {
  "colors.textSubtle": "colors.inkMuted",
  "colors.glassRaised": "colors.fill",
  "colors.accentSoft": "colors.accentWash",
  "colors.border": "colors.hairline",
};

const BREAKPOINTS = new Map(TOKENS.filter((t) => t.group === "layout" && /^(bp|reducedMotion)/.test(t.name)).map((t) => [normCompound(t.value), t]));

/** Deprecated name -> canonical name (same value), for --aliases. */
const ALIASES = {
  "colors.textMuted": "colors.mutedForeground",
  "colors.bgElevated": "colors.card",
  "colors.textOnPlate": "colors.ink",
  "colors.textFaint": "colors.inkFaint",
  "colors.line": "colors.hairline",
  "colors.lineStrong": "colors.hairlineStrong",
  "colors.glass": "colors.fillSubtle",
  "colors.glassHover": "colors.fillStronger",
  "colors.chip": "colors.fillStrong",
  "colors.chipStrong": "colors.fillStronger",
  "colors.overlayScrim": "colors.scrim",
  "colors.overlayMat": "colors.scrimLight",
  "text.lineMeta": "text.lineXs",
  "layout.workspaceBreakpoint": "layout.bpLg",
  "space.xxs": "space.s0_5",
  "space.xs": "space.s1",
  "space.sm": "space.s1_5",
  "space.md": "space.s2",
  "space.lg": "space.s3",
  "space.xl": "space.s4",
  "space.xxl": "space.s6",
  "space.xxxl": "space.s8",
  "space.none": "0",
};

// ---------------------------------------------------------------------------
// Recipes this codemod recognises, as normalised declaration sets.
const RING_OUTLINE = [
  ["outline", ":focus-visible", "2px solid transparent"],
  ["outlineOffset", ":focus-visible", "2px"],
];
const RING_OUTLINE_LONG = [
  ["outlineWidth", ":focus-visible", "2px"],
  ["outlineStyle", ":focus-visible", "solid"],
  ["outlineColor", ":focus-visible", "transparent"],
  ["outlineOffset", ":focus-visible", "2px"],
];
const ring = (shadow) => [RING_OUTLINE, RING_OUTLINE_LONG].map((o) => [...o, ["boxShadow", ":focus-visible", shadow]]);
const TRANSITION_COLORS = "color, background-color, border-color, text-decoration-color, fill, stroke";
const RECIPES = [
  { ref: "a11y.srOnly", module: "recipes", whole: true, sets: [[["position", "", "absolute"], ["width", "", "1px"], ["height", "", "1px"], ["padding", "", "0"], ["margin", "", "-1px"], ["overflow", "", "hidden"], ["clip", "", "rect(0,0,0,0)"], ["whiteSpace", "", "nowrap"], ["borderWidth", "", "0"]]] },
  { ref: "textLayout.truncate", module: "recipes", sets: [[["overflow", "", "hidden"], ["textOverflow", "", "ellipsis"], ["whiteSpace", "", "nowrap"]]] },
  { ref: "focus.ring", module: "recipes", sets: ring("0 0 0 2px hsl(var(--ring))") },
  // The accent ring is the ring: shadows.ring is 2px of the accent.
  { ref: "focus.ring", module: "recipes", sets: ring("0 0 0 2px rgba(232,224,68,1)") },
  { ref: "focus.ringInset", module: "recipes", sets: ring("inset 0 0 0 2px hsl(var(--ring))") },
  { ref: "focus.ring", module: "recipes", sets: ring("0 0 0 1px hsl(var(--card)),0 0 0 3px hsl(var(--ring))") },
  { ref: "motionRecipe.colors", module: "recipes", sets: [[["transitionProperty", "", TRANSITION_COLORS], ["transitionDuration", "", "150ms"], ["transitionTimingFunction", "", "cubic-bezier(0.4,0,0.2,1)"]]] },
  { ref: "motionRecipe.transform", module: "recipes", sets: [[["transitionProperty", "", "transform"], ["transitionDuration", "", "150ms"], ["transitionTimingFunction", "", "cubic-bezier(0.4,0,0.2,1)"]]] },
  {
    ref: "motionRecipe.spin",
    module: "recipes",
    keyframes: "spin",
    sets: [
      [["animationName", "", "@kf:spin"], ["animationDuration", "", "1s"], ["animationTimingFunction", "", "linear"], ["animationIterationCount", "", "infinite"]],
      [["animationName", "", "@kf:spin"], ["animationName", "@media (prefers-reduced-motion: reduce)", "none"], ["animationDuration", "", "1s"], ["animationTimingFunction", "", "linear"], ["animationIterationCount", "", "infinite"]],
    ],
  },
  {
    ref: "motionRecipe.pulse",
    module: "recipes",
    keyframes: "pulse",
    sets: [
      [["animationName", "", "@kf:pulse"], ["animationDuration", "", "2s"], ["animationTimingFunction", "", "cubic-bezier(0.4,0,0.6,1)"], ["animationIterationCount", "", "infinite"]],
      [["animationName", "", "@kf:pulse"], ["animationName", "@media (prefers-reduced-motion: reduce)", "none"], ["animationDuration", "", "2s"], ["animationTimingFunction", "", "cubic-bezier(0.4,0,0.6,1)"], ["animationIterationCount", "", "infinite"]],
    ],
  },
];

// ---------------------------------------------------------------------------
// Module-level helpers.
const tokenSpecifier = (file, module) => {
  if (file.startsWith("packages/studio-ui/src/")) {
    let rel = relative(dirname(join(repoRoot, file)), join(repoRoot, `packages/studio-ui/src/stylex/${module}.stylex`)).split(sep).join("/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  }
  return `@simforge-oss/studio-ui/stylex/${module}.stylex`;
};
const isModule = (spec, module) => new RegExp(`(^|/)stylex/${module}\\.stylex$`).test(spec) || spec === `@simforge-oss/studio-ui/stylex/${module}.stylex`;

/** Resolve a value node to a comparable string: literals, local consts, token refs (by value) and keyframes. */
function resolveValue(m, node, kfNames) {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return resolveValue(m, node.expression, kfNames);
  const lit = staticValue(node, m.consts);
  if (lit !== undefined) return lit;
  if (ts.isIdentifier(node) && kfNames.has(node.text)) return `@kf:${kfNames.get(node.text)}`;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const imp = m.imports.get(node.expression.text);
    if (imp && /tokens\.stylex$/.test(imp.spec)) {
      const t = tokenByRef.get(`${imp.imported === "*" ? node.expression.text : imp.imported}.${node.name.text}`);
      if (t) return t.value;
    }
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const v = resolveValue(m, span.expression, kfNames);
      if (v === undefined) return undefined;
      out += String(v) + span.literal.text;
    }
    return out;
  }
  if (ts.isIdentifier(node) && m.consts.has(node.text)) return resolveValue(m, m.consts.get(node.text), kfNames);
  return undefined;
}

/** Local keyframes that are the shared spin/pulse, by binding name. */
function sharedKeyframes(m) {
  const out = new Map();
  for (const [name, init] of m.consts) {
    if (!ts.isCallExpression(init) || !/keyframes$/.test(init.expression.getText(m.sf))) continue;
    const arg = init.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
    const text = arg.getText(m.sf).replace(/\s+/g, "").replace(/,}/g, "}").replace(/["']/g, "");
    if (/^\{from:\{transform:rotate\(0deg\)\},to:\{transform:rotate\(360deg\)\}\}$/.test(text) || /^\{to:\{transform:rotate\(360deg\)\}\}$/.test(text)) out.set(name, "spin");
    else if (/^\{(0%,100%:\{opacity:1\},)?50%:\{opacity:0?\.5\}\}$/.test(text)) out.set(name, "pulse");
  }
  return out;
}

// ---------------------------------------------------------------------------
const models = loadModels(repoRoot);
const resolveTarget = (from, spec) => resolveSpecifier(from, spec, repoRoot);
/** Modules the package exports by subpath: code outside this repository may read their keys. */
const PUBLIC_MODULES = new Set(
  Object.values(JSON.parse(readFileSync(join(repoRoot, "packages/studio-ui/package.json"), "utf8")).exports)
    .map((e) => (typeof e === "object" ? e.development : null))
    .filter((d) => typeof d === "string")
    .map((d) => `packages/studio-ui/${d.replace(/^\.\//, "")}`),
);
const byFile = new Map(models.map((m) => [m.file, m]));
const refs = collectReferences(models, repoRoot);

/** Per-file edit lists and imports to add: file -> { edits: [], imports: Map<module, Set<name>> } */
const plan = new Map();
const planFor = (file) => {
  if (!plan.has(file)) plan.set(file, { edits: [], imports: new Map(), removedRanges: [] });
  return plan.get(file);
};
const needImport = (file, module, name) => {
  const p = planFor(file);
  if (!p.imports.has(module)) p.imports.set(module, new Set());
  p.imports.get(module).add(name);
};
const stats = { tokens: 0, breakpoints: 0, constsInlined: 0, aliases: 0, recipeKeys: {}, recipeRefs: 0, deadKeys: 0, deadModules: 0, radii: 0, skippedFiles: 0 };

/** Range of a property assignment including its trailing comma and leading line. */
function memberRange(m, member) {
  const src = m.source;
  let start = member.getFullStart();
  let end = member.getEnd();
  // swallow the trailing comma
  let i = end;
  while (i < src.length && /[ \t]/.test(src[i])) i++;
  if (src[i] === ",") end = i + 1;
  return [start, end];
}

const declaredCache = new Map();
/** Every name the file declares anywhere (bindings, params, functions, imports). */
function declaredNames(m) {
  if (declaredCache.has(m.file)) return declaredCache.get(m.file);
  const names = new Set(m.imports.keys());
  (function visit(n) {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) names.add(n.name.text);
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) names.add(n.name.text);
    ts.forEachChild(n, visit);
  })(m.sf);
  declaredCache.set(m.file, names);
  return names;
}
const aliasFor = new Map(); // `${file}#${module}#${group}` -> local name chosen this run
/** Local name under which the token/recipe group is (or will be) imported in `m`. */
function groupLocal(m, module, group) {
  for (const [local, imp] of m.imports) if (isModule(imp.spec, module) && imp.imported === group) return local;
  const key = `${m.file}#${module}#${group}`;
  if (aliasFor.has(key)) return aliasFor.get(key);
  const taken = declaredNames(m);
  let local = group;
  if (taken.has(group)) local = `${group}${module === "tokens" ? "Tokens" : "Recipe"}`;
  if (local !== group && taken.has(local)) return null;
  aliasFor.set(key, local);
  return local;
}

// ---------------------------------------------------------------------------
// 1. Recipes (decided first: the declarations they absorb are not token-swapped).
const absorbed = new Set(); // member nodes removed by a recipe
const keyRecipes = new Map(); // `${file}#${binding}#${key}` -> { recipes: [refs], emptied: bool }
if (flag("recipes") || flag("roles")) {
  for (const m of models) {
    if (isExcluded(m.file)) continue;
    const kf = sharedKeyframes(m);
    for (const c of m.creates) {
      if (!c.binding) continue;
      const r = refs.get(`${m.file}#${c.binding}`);
      if (!r || r.computed || r.escapes) continue;
      for (const ns of c.namespaces) {
        if (ns.unsupported || ns.dynamic) continue;
        // A key read from a file this run may not edit keeps its declarations.
        if (r.refs.some((x) => x.key === ns.key && isExcluded(x.file))) continue;
        // Group leaf declarations by their top-level property assignment.
        const tops = new Map();
        for (const d of ns.decls) {
          if (!tops.has(d.top)) tops.set(d.top, []);
          tops.get(d.top).push(d);
        }
        const tuples = [];
        for (const [top, ds] of tops) {
          for (const d of ds) {
            let v = resolveValue(m, d.valueNode, kf);
            if (v === undefined) {
              tuples.push({ top, key: null });
              continue;
            }
            if (d.value === null && d.conds.length === 0) continue; // `default: null`
            if (typeof v === "string" && /^(boxShadow|clip|transitionProperty|transitionTimingFunction|animationTimingFunction|outline)$/.test(d.prop)) v = normCompound(v);
            if (typeof v === "number" && /^(width|height|margin|padding|borderWidth)$/.test(d.prop)) v = v === 0 ? "0" : `${v}px`;
            if (typeof v === "string" && d.prop === "transitionProperty") v = v.replace(/,/g, ", ");
            tuples.push({ top, key: `${d.prop}|${d.conds.join(">")}|${v}` });
          }
        }
        const chosen = [];
        const used = new Set();
        for (const recipe of RECIPES) {
          for (const set of recipe.sets) {
            const want = set.map(([p, c, v]) => `${p}|${c}|${p === "transitionProperty" ? v : typeof v === "string" ? (/^(boxShadow|clip|transitionTimingFunction|animationTimingFunction|outline)$/.test(p) ? normCompound(v) : v) : v}`);
            // every wanted tuple present, and every top-level prop it touches holds only wanted tuples
            const touched = new Set();
            let ok = true;
            for (const w of want) {
              const hit = tuples.find((t) => t.key === w && !used.has(t.top));
              if (!hit) { ok = false; break; }
              touched.add(hit.top);
            }
            if (!ok) continue;
            for (const top of touched) {
              const all = tuples.filter((t) => t.top === top);
              if (all.some((t) => t.key === null || !want.includes(t.key))) ok = false;
            }
            if (!ok) continue;
            if (recipe.whole && touched.size !== tops.size) continue;
            for (const top of touched) used.add(top);
            chosen.push(recipe);
            break;
          }
        }
        if (flag("roles")) {
          // Visual pass: a look written out by hand becomes its role recipe,
          // whatever its exact values were. Only unconditioned (or purely
          // focus-conditioned) declarations are taken, so state stays local.
          const topProp = (top) => top.name.getText(m.sf).replace(/^["']|["']$/g, "");
          const declsOf = (top) => tops.get(top) ?? [];
          const plain = (top) => declsOf(top).every((d) => d.conds.length === 0);
          const free = [...tops.keys()].filter((t) => !used.has(t));
          const byProp = new Map(free.map((t) => [topProp(t), t]));
          const val = (prop) => {
            const t = byProp.get(prop);
            if (!t || !plain(t)) return undefined;
            return resolveValue(m, declsOf(t)[0].valueNode, kf);
          };
          // Eyebrow / tag / caps: uppercase, tracked, small.
          const upper = val("textTransform");
          const size = val("fontSize");
          const px = typeof size === "string" ? (size.endsWith("rem") ? parseFloat(size) * 16 : size.endsWith("px") ? parseFloat(size) : NaN) : NaN;
          if (upper === "uppercase" && byProp.has("letterSpacing") && px <= 12) {
            const role = px <= 9 ? "typography.tag" : px <= 11 ? "typography.eyebrow" : "typography.caps";
            const take = ["fontFamily", "fontSize", "letterSpacing", "textTransform", "fontWeight", "lineHeight"].map((p) => byProp.get(p)).filter((t) => t && plain(t));
            for (const t of take) used.add(t);
            chosen.push({ ref: role });
          }
          // Focus: every outline/box-shadow declaration is a focus state.
          const focusTops = free.filter((t) => /^(outline|outlineWidth|outlineStyle|outlineColor|outlineOffset|boxShadow)$/.test(topProp(t)));
          const isFocus = (d) => (d.value === null && d.conds.length === 0) || d.conds.some((c) => /^:focus(-visible)?$/.test(c));
          if (focusTops.length && !chosen.some((x) => x.ref.startsWith("focus.")) && focusTops.every((t) => declsOf(t).every(isFocus)) && focusTops.some((t) => declsOf(t).some((d) => d.conds.length))) {
            const inset = focusTops.some((t) => declsOf(t).some((d) => /inset/.test(String(resolveValue(m, d.valueNode, kf) ?? ""))));
            for (const t of focusTops) used.add(t);
            chosen.push({ ref: inset ? "focus.ringInset" : "focus.ring" });
          }
          // Hairline: a 1px solid border in a hairline colour on every side.
          const bw = val("borderWidth");
          const bs = val("borderStyle");
          const bc = byProp.get("borderColor");
          const bcv = bc && plain(bc) ? resolveValue(m, declsOf(bc)[0].valueNode, kf) : undefined;
          const hairlineColor = { "rgba(255,255,255,0.05)": "hairline.subtle", "rgba(255,255,255,0.08)": null, "rgba(255,255,255,0.14)": "hairline.strong" };
          const nbc = typeof bcv === "string" ? normColor(bcv) : null;
          if ((bw === 1 || bw === "1px") && bs === "solid" && nbc && nbc in hairlineColor) {
            for (const p of ["borderWidth", "borderStyle", "borderColor"]) used.add(byProp.get(p));
            chosen.push({ ref: "hairline.all" });
            if (hairlineColor[nbc]) chosen.push({ ref: hairlineColor[nbc] });
          }
        }
        if (!chosen.length) continue;
        const emptied = used.size === tops.size;
        keyRecipes.set(`${m.file}#${c.binding}#${ns.key}`, { recipes: chosen.map((x) => x.ref), emptied, ns, m, create: c });
        for (const top of used) absorbed.add(top);
        for (const x of chosen) stats.recipeKeys[x.ref] = (stats.recipeKeys[x.ref] ?? 0) + 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1b. Empty keys (left behind when another codemod moved every declaration
// out): references become `null`, which stylex.props and xstyle ignore.
const emptyKeys = new Set();
if (flag("empty")) {
  for (const m of models) {
    if (isExcluded(m.file)) continue;
    for (const c of m.creates) {
      if (!c.binding) continue;
      const r = refs.get(`${m.file}#${c.binding}`);
      if (!r || r.computed || r.escapes || r.reexported || PUBLIC_MODULES.has(m.file)) continue;
      for (const ns of c.namespaces) {
        if (ns.object && ns.object.properties.length === 0 && !r.refs.some((x) => x.key === ns.key && isExcluded(x.file))) emptyKeys.add(`${m.file}#${c.binding}#${ns.key}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Dead keys and modules.
const deadKeys = new Set();
if (flag("dead")) {
  for (const m of models) {
    if (isExcluded(m.file)) continue;
    for (const c of m.creates) {
      if (!c.binding) continue;
      const r = refs.get(`${m.file}#${c.binding}`);
      if (!r || r.computed || r.escapes || r.reexported || PUBLIC_MODULES.has(m.file)) continue;
      const used = new Set(r.refs.map((x) => x.key));
      for (const ns of c.namespaces) if (!used.has(ns.key)) deadKeys.add(`${m.file}#${c.binding}#${ns.key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Per-file declaration edits.
for (const m of models) {
  if (isExcluded(m.file)) continue;
  const p = planFor(m.file);
  const kf = sharedKeyframes(m);
  const skipTop = new Set();
  const inlineConsts = new Map(); // const name -> replacement text

  for (const c of m.creates) {
    const importedElsewhere = c.binding && models.some((o) => o !== m && [...o.imports.values()].some((imp) => imp.imported === c.binding && resolveTarget(o.file, imp.spec) === m.file));
    const allDead = c.binding && !importedElsewhere && c.namespaces.length > 0 && c.namespaces.every((ns) => deadKeys.has(`${m.file}#${c.binding}#${ns.key}`));
    for (const ns of c.namespaces) {
      const id = `${m.file}#${c.binding}#${ns.key}`;
      const kr = keyRecipes.get(id);
      if ((deadKeys.has(id) || emptyKeys.has(id)) && !allDead) {
        p.edits.push([...memberRange(m, ns.member), ""]);
        stats.deadKeys++;
        continue;
      }
      if (kr?.emptied) {
        p.edits.push([...memberRange(m, ns.member), ""]);
        continue;
      }
      if (ns.unsupported) continue;
      const tops = new Set();
      for (const d of ns.decls) tops.add(d.top);
      for (const top of tops) {
        if (absorbed.has(top)) {
          p.edits.push([...memberRange(m, top), ""]);
          skipTop.add(top);
          continue;
        }
        const topName = top.name.getText(m.sf).replace(/^["']|["']$/g, "");
        if (flag("radii") && /^border(Top|Bottom|Start|End)?(Left|Right|Start|End)?Radius$/.test(topName) && !DESKTOP_SHELL.test(m.file)) {
          p.edits.push([...memberRange(m, top), ""]);
          skipTop.add(top);
          stats.radii++;
        }
      }
      if (!flag("tokens") && !flag("collapse")) continue;
      for (const d of ns.decls) {
        if (skipTop.has(d.top)) continue;
        const node = d.valueNode;
        const direct = ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand));
        const viaConst = ts.isIdentifier(node) && m.consts.has(node.text) && staticValue(node, m.consts) !== undefined;
        if (!direct && !viaConst) continue;
        const raw = staticValue(node, m.consts);
        const tok = (flag("tokens") ? findToken(d.prop, raw) : null) ?? (flag("collapse") ? collapseToken(d.prop, raw) : null);
        if (!tok) continue;
        const local = groupLocal(m, "tokens", tok.group);
        if (!local) continue;
        if (direct) {
          p.edits.push([node.getStart(m.sf), node.getEnd(), `${local}.${tok.name}`]);
          needImport(m.file, "tokens", tok.group);
          stats.tokens++;
        } else {
          // Inline the const only if every use of it swaps to this same token.
          const prev = inlineConsts.get(node.text);
          if (prev === undefined) inlineConsts.set(node.text, `${local}.${tok.name}`);
          else if (prev !== `${local}.${tok.name}`) inlineConsts.set(node.text, null);
        }
      }
      // Literal breakpoint keys. Only where the object holds a single width
      // query and sits inside a property: StyleX rewrites several literal
      // min-width queries on one property into non-overlapping ranges, which
      // it cannot do for consts, and it only accepts a literal at-rule as a
      // namespace-level (contextual) key.
      const isWidthQuery = (mem) => {
        const k = ts.isStringLiteral(mem.name) ? mem.name.text : ts.isComputedPropertyName(mem.name) ? staticValue(mem.name.expression, m.consts) : null;
        return typeof k === "string" && /^@media\s*\((min|max)-width/.test(k);
      };
      (function keys(obj, depth) {
        const widthQueries = obj.properties.filter((mem) => ts.isPropertyAssignment(mem) && isWidthQuery(mem)).length;
        for (const mem of obj.properties) {
          if (!ts.isPropertyAssignment(mem)) continue;
          if (ts.isObjectLiteralExpression(mem.initializer)) keys(mem.initializer, depth + 1);
          if (depth === 0) {
            // A namespace-level at-rule key: any const it reads must stay a literal.
            if (ts.isComputedPropertyName(mem.name) && ts.isIdentifier(mem.name.expression)) inlineConsts.set(mem.name.expression.text, null);
            continue;
          }
          if (isWidthQuery(mem) && widthQueries > 1) {
            if (ts.isComputedPropertyName(mem.name) && ts.isIdentifier(mem.name.expression)) inlineConsts.set(mem.name.expression.text, null);
            continue;
          }
          let keyVal = null;
          let constName = null;
          if (ts.isStringLiteral(mem.name)) keyVal = mem.name.text;
          else if (ts.isComputedPropertyName(mem.name) && ts.isIdentifier(mem.name.expression) && m.consts.has(mem.name.expression.text)) {
            constName = mem.name.expression.text;
            keyVal = staticValue(mem.name.expression, m.consts);
          }
          if (typeof keyVal !== "string") continue;
          const bp = BREAKPOINTS.get(normCompound(keyVal));
          if (!bp) continue;
          const local = groupLocal(m, "tokens", "layout");
          if (!local) continue;
          if (constName) {
            const prev = inlineConsts.get(constName);
            if (prev === undefined) inlineConsts.set(constName, `${local}.${bp.name}`);
            else if (prev !== `${local}.${bp.name}`) inlineConsts.set(constName, null);
          } else {
            p.edits.push([mem.name.getStart(m.sf), mem.name.getEnd(), `[${local}.${bp.name}]`]);
            needImport(m.file, "tokens", "layout");
            stats.breakpoints++;
          }
        }
      })(ns.object ?? { properties: [] }, 0);
    }
    if (allDead) {
      // An entire create() whose keys are all dead: drop the declaration statement.
      const stmt = c.call.parent?.parent?.parent;
      if (stmt && ts.isVariableStatement(stmt)) p.edits.push([stmt.getFullStart(), stmt.getEnd(), ""]);
      stats.deadKeys += c.namespaces.length;
    }
  }

  // Inline consts whose every reference is a style value we swapped the same way.
  if (flag("tokens")) {
    for (const [name, replacement] of inlineConsts) {
      if (!replacement) continue;
      const decl = m.constDecls.get(name);
      if (!decl || !ts.isVariableStatement(decl.parent?.parent) || decl.parent.declarations.length !== 1) continue;
      const stmt = decl.parent.parent;
      if (ts.getModifiers(stmt)?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword)) continue;
      // every identifier use must sit inside a create()/keyframes() argument or a template span within one
      const uses = [];
      let outside = false;
      (function visit(n) {
        if (ts.isIdentifier(n) && n.text === name && n !== decl.name) {
          const parent = n.parent;
          if (ts.isPropertyAccessExpression(parent) && parent.name === n) return;
          if (ts.isPropertyAssignment(parent) && parent.name === n) return;
          let inside = false;
          for (let a = n.parent; a; a = a.parent) {
            if (ts.isCallExpression(a) && /(create|keyframes)$/.test(a.expression.getText(m.sf))) { inside = true; break; }
          }
          if (!inside) outside = true;
          uses.push(n);
        }
        ts.forEachChild(n, visit);
      })(m.sf);
      if (outside || uses.length === 0) continue;
      const [grp] = replacement.split(".");
      const tokGroup = TOKENS.find((t) => t.ref.endsWith(replacement.slice(replacement.indexOf("."))) && groupLocal(m, "tokens", t.group) === grp)?.group ?? grp;
      // Uses inside a template span or computed key keep working as an expression.
      for (const u of uses) {
        const inSkipped = [...skipTop].some((t) => u.getStart(m.sf) >= t.getStart(m.sf) && u.getEnd() <= t.getEnd());
        if (inSkipped) continue;
        p.edits.push([u.getStart(m.sf), u.getEnd(), replacement]);
      }
      p.edits.push([stmt.getFullStart(), stmt.getEnd(), ""]);
      needImport(m.file, "tokens", tokGroup);
      stats.constsInlined++;
    }
  }

  // Aliases: deprecated token names -> canonical.
  if (flag("aliases") || flag("collapse")) {
    (function visit(n) {
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const imp = m.imports.get(n.expression.text);
        if (imp && isModule(imp.spec, "tokens")) {
          const group = imp.imported === "*" ? null : imp.imported;
          const target = group && (ALIASES[`${group}.${n.name.text}`] ?? (flag("collapse") ? COLLAPSE_ALIASES[`${group}.${n.name.text}`] : undefined));
          const inSkipped = [...skipTop].some((t) => n.getStart(m.sf) >= t.getStart(m.sf) && n.getEnd() <= t.getEnd());
          if (target && !inSkipped && !p.edits.some(([s, e]) => n.getStart(m.sf) >= s && n.getEnd() <= e)) {
            if (target === "0") p.edits.push([n.getStart(m.sf), n.getEnd(), "0"]);
            else {
              const [g, k] = target.split(".");
              const local = g === group ? n.expression.text : groupLocal(m, "tokens", g);
              if (local) {
                p.edits.push([n.getStart(m.sf), n.getEnd(), `${local}.${k}`]);
                if (g !== group) needImport(m.file, "tokens", g);
              }
            }
            stats.aliases++;
          }
          return;
        }
      }
      ts.forEachChild(n, visit);
    })(m.sf);
  }

  // Keyframes that became unused after recipe replacement.
  if (flag("recipes")) {
    for (const [name] of kf) {
      const decl = m.constDecls.get(name);
      const stmt = decl?.parent?.parent;
      if (!stmt || !ts.isVariableStatement(stmt)) continue;
      let remaining = 0;
      (function visit(n) {
        if (ts.isIdentifier(n) && n.text === name && n !== decl.name) {
          const inRemoved = p.edits.some(([s, e, t]) => t === "" && n.getStart(m.sf) >= s && n.getEnd() <= e);
          if (!inRemoved) remaining++;
        }
        ts.forEachChild(n, visit);
      })(m.sf);
      if (remaining === 0) p.edits.push([stmt.getFullStart(), stmt.getEnd(), ""]);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Reference rewrites for recipe keys.
for (const [id, kr] of keyRecipes) {
  const [file, binding, key] = id.split("#");
  const r = refs.get(`${file}#${binding}`);
  for (const ref of r.refs) {
    if (ref.key !== key || isExcluded(ref.file)) continue;
    const rm = byFile.get(ref.file);
    const locals = [];
    let clash = false;
    for (const recipeRef of kr.recipes) {
      const [group, name] = recipeRef.split(".");
      const local = groupLocal(rm, "recipes", group);
      if (!local) { clash = true; break; }
      locals.push(`${local}.${name}`);
      needImport(ref.file, "recipes", group);
    }
    if (clash) throw new Error(`recipe import name clash in ${ref.file}`);
    const text = kr.emptied ? (locals.length === 1 ? locals[0] : `[${locals.join(", ")}]`) : `[${[...locals, ref.node.getText(rm.sf)].join(", ")}]`;
    planFor(ref.file).edits.push([ref.node.getStart(rm.sf), ref.node.getEnd(), text]);
    stats.recipeRefs++;
  }
}

for (const id of emptyKeys) {
  const [file, binding, key] = id.split("#");
  for (const ref of refs.get(`${file}#${binding}`).refs) {
    if (ref.key !== key) continue;
    const rm = byFile.get(ref.file);
    const parent = ref.node.parent;
    // `xstyle={styles.x}` loses the attribute; anything else reads null.
    if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
      const attr = parent.parent;
      planFor(ref.file).edits.push([attr.getFullStart(), attr.getEnd(), ""]);
    } else {
      planFor(ref.file).edits.push([ref.node.getStart(rm.sf), ref.node.getEnd(), "null"]);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Orphan style modules (no importer, not an entry point).
const deadModules = [];
if (flag("dead")) {
  const imported = new Set();
  for (const m of models) for (const [, imp] of m.imports) {
    if (imp.spec.startsWith(".") || imp.spec.startsWith("@/") || imp.spec.startsWith("@simforge-oss/studio-ui/")) {
      const base = imp.spec.startsWith(".") ? join(dirname(m.file), imp.spec) : imp.spec.startsWith("@/") ? join("studio", imp.spec.slice(2)) : join("packages/studio-ui/src", imp.spec.slice("@simforge-oss/studio-ui/".length));
      imported.add(base.split(sep).join("/").replace(/\.tsx?$/, ""));
    }
  }
  for (const m of models) {
    if (!/\.stylex\.ts$/.test(m.file) || isExcluded(m.file)) continue;
    if (!imported.has(m.file.replace(/\.ts$/, "")) && m.creates.length > 0) deadModules.push(m.file);
  }
}

// ---------------------------------------------------------------------------
// 6. Imports, then write.
function importEdits(m, imports) {
  const edits = [];
  for (const [module, names] of imports) {
    const existing = m.importDecls.find((d) => isModule(d.moduleSpecifier.text, module));
    const have = new Set();
    if (existing) {
      const nb = existing.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) have.add((el.propertyName ?? el.name).text);
    }
    const add = [...names].filter((n) => !have.has(n)).sort().map((n) => {
      const local = aliasFor.get(`${m.file}#${module}#${n}`) ?? n;
      return local === n ? n : `${n} as ${local}`;
    });
    if (!add.length) continue;
    if (existing && existing.importClause?.namedBindings && ts.isNamedImports(existing.importClause.namedBindings)) {
      const nb = existing.importClause.namedBindings;
      const all = [...nb.elements.map((el) => el.getText(m.sf)), ...add].sort((a, b) => a.localeCompare(b));
      const multiline = nb.getText(m.sf).includes("\n");
      const text = multiline ? `{\n  ${all.join(",\n  ")},\n}` : `{ ${all.join(", ")} }`;
      edits.push([nb.getStart(m.sf), nb.getEnd(), text]);
    } else {
      const spec = tokenSpecifier(m.file, module);
      const last = m.importDecls[m.importDecls.length - 1];
      const at = last ? last.getEnd() : 0;
      edits.push([at, at, `${last ? "\n" : ""}import { ${add.join(", ")} } from "${spec}";${last ? "" : "\n"}`]);
    }
  }
  return edits;
}

let changed = 0;
for (const [file, p] of plan) {
  if (!p.edits.length) continue;
  const m = byFile.get(file) ?? modelFile(file, readFileSync(join(repoRoot, file), "utf8"));
  // Drop edits nested inside a removed range (a deleted key or declaration).
  const removals = p.edits.filter(([, , t]) => t === "");
  const kept = p.edits.filter((e) => !removals.some((r) => r !== e && e[0] >= r[0] && e[1] <= r[1] && !(e[0] === r[0] && e[1] === r[1])));
  const unique = [];
  const seen = new Set();
  for (const e of kept) {
    const k = `${e[0]}:${e[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(e);
  }
  const all = [...unique, ...importEdits(m, p.imports)];
  let out;
  try {
    out = applyEdits(m.source, all);
  } catch (error) {
    process.stderr.write(`skip ${file}: ${error.message}\n`);
    stats.skippedFiles++;
    continue;
  }
  // Drop token imports nothing uses any more (e.g. `radii` after --radii).
  out = pruneImports(file, out);
  if (out !== m.source) {
    changed++;
    if (!DRY) writeFileSync(join(repoRoot, file), out);
  }
}
for (const file of deadModules) {
  stats.deadModules++;
  if (!DRY) rmSync(join(repoRoot, file));
}

function pruneImports(file, source) {
  const m = modelFile(file, source);
  const edits = [];
  for (const decl of m.importDecls) {
    const spec = decl.moduleSpecifier.text;
    if (!isModule(spec, "tokens") && !isModule(spec, "recipes")) continue;
    const nb = decl.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    const used = nb.elements.filter((el) => {
      const name = el.name.text;
      let count = 0;
      (function visit(n) {
        if (ts.isIdentifier(n) && n.text === name && !ts.isImportSpecifier(n.parent)) count++;
        ts.forEachChild(n, visit);
      })(m.sf);
      return count > 0;
    });
    if (used.length === nb.elements.length) continue;
    if (used.length === 0) edits.push([decl.getFullStart(), decl.getEnd(), ""]);
    else {
      const multiline = nb.getText(m.sf).includes("\n");
      const texts = used.map((el) => el.getText(m.sf));
      edits.push([nb.getStart(m.sf), nb.getEnd(), multiline ? `{\n  ${texts.join(",\n  ")},\n}` : `{ ${texts.join(", ")} }`]);
    }
  }
  return edits.length ? applyEdits(source, edits) : source;
}

const reportPath = opt("report");
if (reportPath) {
  const report = {
    recipeKeys: [...keyRecipes].map(([id, kr]) => ({ id, recipes: kr.recipes, emptied: kr.emptied })),
    deadKeys: [...deadKeys],
    deadModules,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 1));
}
process.stdout.write(`${DRY ? "[dry] " : ""}${changed} file(s) changed; ${JSON.stringify(stats)}; dead modules: ${deadModules.join(", ") || "none"}\n`);
