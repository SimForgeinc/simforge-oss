/**
 * Offset-preserving OpenDRIVE text layer for the elevation refit.
 *
 * The refit may change exactly three things: `<elevationProfile>`,
 * `<lateralProfile>` and lane `<height>` (laneHeight). Everything else must
 * stay byte-identical, so the corrected file is produced by splicing new text
 * into the original at the byte ranges of those elements, never by
 * re-serialising a parsed tree. {@link structuralDiff} then proves the result.
 */

import { lineRange, scanXml, xodrGeometryProjection, xodrGeometrySha256, xmlChild as child, xmlChildrenNamed as childrenNamed, type XmlElement } from '@simforge-oss/maps/node';

export { child, childrenNamed, lineRange, scanXml, xodrGeometrySha256, type XmlElement };

/** The text with every allowed element's lines removed (what must be byte-identical). */
export const frozenText = xodrGeometryProjection;

/**
 * RoadRunner's number style: `%.16e` with a two-digit exponent
 * (`7.7144044016421036e+00`). Every value the refit writes uses it so the
 * corrected file reads like the source.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`xodr: refusing to write non-finite number ${value}`);
  if (value === 0 || Object.is(value, -0)) return '0.0000000000000000e+00';
  return value.toExponential(16).replace(/e([+-])(\d)$/, 'e$10$2');
}

export interface TextEdit { start: number; end: number; text: string }

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const edit of sorted) {
    if (edit.start < at) throw new Error(`xodr: overlapping edits at offset ${edit.start}`);
    out += text.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + text.slice(at);
}

/** Line ending used by the document. */
export function newlineOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Whitespace between the start of `offset`'s line and `offset` (the element's indentation). */
export function indentAt(text: string, offset: number): string {
  let i = offset;
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1;
  return text.slice(i, offset);
}

export function emptyElement(name: string, attrs: readonly [string, string][]): string {
  return `<${name}${attrs.map(([k, v]) => ` ${k}="${v}"`).join('')}/>`;
}

// ---------------------------------------------------------------------------
// Structural diff
// ---------------------------------------------------------------------------

export interface StructuralDifference {
  path: string;
  kind: 'added' | 'removed' | 'attributes';
  detail?: string;
}

export interface StructuralDiffResult {
  /** Every differing element path. */
  differences: StructuralDifference[];
  /** Differences outside elevationProfile, lateralProfile and lane/height. */
  forbidden: StructuralDifference[];
  /** Counts of changed paths per allowed category. */
  allowedCounts: { elevationProfile: number; lateralProfile: number; laneHeight: number };
  /** Byte ranges of the original outside the allowed elements are identical in the corrected file. */
  bytesOutsideAllowedIdentical: boolean;
}

function keyOf(node: XmlElement, index: number): string {
  const id = node.attrs['id'];
  if (node.name === 'road' || node.name === 'junction' || node.name === 'lane' || node.name === 'signal' || node.name === 'object' || node.name === 'controller') {
    return `${node.name}[id=${id ?? '?'}]`;
  }
  return `${node.name}[${index}]`;
}

function flatten(root: XmlElement): Map<string, { attrs: Record<string, string>; allowed: 'elevationProfile' | 'lateralProfile' | 'laneHeight' | null }> {
  const out = new Map<string, { attrs: Record<string, string>; allowed: 'elevationProfile' | 'lateralProfile' | 'laneHeight' | null }>();
  const walk = (node: XmlElement, prefix: string, allowed: 'elevationProfile' | 'lateralProfile' | 'laneHeight' | null, parentName: string) => {
    const counters = new Map<string, number>();
    for (const c of node.children) {
      const n = counters.get(c.name) ?? 0;
      counters.set(c.name, n + 1);
      let category = allowed;
      if (!category && (c.name === 'elevationProfile' || c.name === 'lateralProfile') && parentName === 'road') category = c.name;
      if (!category && c.name === 'height' && node.name === 'lane') category = 'laneHeight';
      const key = `${prefix}/${keyOf(c, n)}`;
      if (out.has(key)) throw new Error(`xodr: duplicate element path ${key}`);
      out.set(key, { attrs: c.attrs, allowed: category });
      walk(c, key, category, c.name);
    }
  };
  walk(root, '', null, '#root');
  return out;
}

/**
 * Compare two OpenDRIVE documents element by element (path keyed by element
 * ids where the schema has them, else by sibling index) and classify every
 * difference. A corrected file is acceptable only when `forbidden` is empty
 * and `bytesOutsideAllowedIdentical` holds: the bytes of everything except
 * elevationProfile, lateralProfile and lane height lines are unchanged.
 */
export function structuralDiff(originalText: string, correctedText: string): StructuralDiffResult {
  const a = scanXml(originalText);
  const b = scanXml(correctedText);
  const fa = flatten(a);
  const fb = flatten(b);
  const differences: StructuralDifference[] = [];
  for (const [path, left] of fa) {
    const right = fb.get(path);
    if (!right) { differences.push({ path, kind: 'removed' }); continue; }
    const keys = new Set([...Object.keys(left.attrs), ...Object.keys(right.attrs)]);
    const changed = [...keys].filter((k) => left.attrs[k] !== right.attrs[k]);
    if (changed.length > 0) differences.push({ path, kind: 'attributes', detail: changed.join(',') });
  }
  for (const path of fb.keys()) if (!fa.has(path)) differences.push({ path, kind: 'added' });
  const category = (d: StructuralDifference) => (fa.get(d.path) ?? fb.get(d.path))!.allowed;
  const forbidden = differences.filter((d) => {
    const own = category(d);
    if (own) return false;
    return true;
  });
  const allowedCounts = { elevationProfile: 0, lateralProfile: 0, laneHeight: 0 };
  for (const d of differences) {
    const c = category(d);
    if (c) allowedCounts[c] += 1;
  }
  return { differences, forbidden, allowedCounts, bytesOutsideAllowedIdentical: frozenText(originalText, a) === frozenText(correctedText, b) };
}
