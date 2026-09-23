/**
 * The road-geometry projection of an OpenDRIVE file.
 *
 * An OpenDRIVE road surface has a horizontal part (planView, lanes, links,
 * junctions, signals, objects, ids) and a vertical part (`<elevationProfile>`,
 * `<lateralProfile>`, lane `<height>`). A map republished with only a
 * corrected vertical profile (the elevation refit,
 * docs/engineering/xodr-elevation-refit.md) keeps every anchor a scenario
 * places, so the two files are the same road geometry.
 *
 * {@link xodrGeometryProjection} is the file with every vertical-profile
 * element removed together with its whole line(s) (indentation and trailing
 * newline); every other byte is kept as is. `xodrGeometrySha256`
 * (`@simforge-oss/maps/node`) is its sha256: equal digests mean
 * byte-identical horizontal geometry. Byte-level on purpose: two exports of
 * the same source either keep those bytes or they are different geometry.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Offset of `<` of the opening tag. */
  start: number;
  /** Offset just past the opening tag's `>`. */
  openEnd: number;
  /** Offset just past the closing tag (or the self-closing tag). */
  end: number;
}

const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Element tree with byte offsets (attributes and nesting; text content is ignored). */
export function scanXml(text: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [], start: 0, openEnd: 0, end: text.length };
  const stack: XmlElement[] = [root];
  TAG.lastIndex = 0;
  for (let match = TAG.exec(text); match; match = TAG.exec(text)) {
    const name = match[2];
    if (!name) continue;
    const at = match.index;
    const after = at + match[0].length;
    if (match[1] === '/') {
      const top = stack[stack.length - 1]!;
      if (stack.length < 2 || top.name !== name) throw new Error(`xodr: unbalanced </${name}> at offset ${at} (open element <${top.name}>)`);
      top.end = after;
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = 0;
    for (const a of (match[3] ?? '').matchAll(ATTR)) attrs[a[1]!] = a[3] ?? a[4] ?? '';
    const node: XmlElement = { name, attrs, children: [], start: at, openEnd: after, end: after };
    stack[stack.length - 1]!.children.push(node);
    if (match[4] !== '/') stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`xodr: unclosed <${stack[stack.length - 1]!.name}>`);
  return root;
}

export const child = (node: XmlElement | undefined, name: string): XmlElement | undefined => node?.children.find((c) => c.name === name);
export const childrenNamed = (node: XmlElement | undefined, name: string): XmlElement[] => node?.children.filter((c) => c.name === name) ?? [];

/**
 * The range covering an element's whole line(s): from the first byte of its
 * indentation to just past its trailing newline, so deleting it leaves no
 * blank line. Only used when the element sits alone on its lines.
 */
export function lineRange(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s -= 1;
  let e = end;
  if (text.startsWith('\r\n', e)) e += 2;
  else if (text[e] === '\n') e += 1;
  return { start: s, end: e };
}

export function verticalProfileRanges(root: XmlElement, text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const opendrive = child(root, 'OpenDRIVE');
  for (const road of childrenNamed(opendrive, 'road')) {
    for (const c of road.children) {
      if (c.name === 'elevationProfile' || c.name === 'lateralProfile') ranges.push(lineRange(text, c.start, c.end));
    }
    for (const section of childrenNamed(child(road, 'lanes'), 'laneSection')) {
      for (const side of ['left', 'center', 'right']) {
        for (const lane of childrenNamed(child(section, side), 'lane')) {
          for (const h of childrenNamed(lane, 'height')) ranges.push(lineRange(text, h.start, h.end));
        }
      }
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The text with every allowed element's lines removed (what must be byte-identical). */
export function xodrGeometryProjection(text: string, root: XmlElement = scanXml(text)): string {
  let out = '';
  let at = 0;
  for (const r of verticalProfileRanges(root, text)) {
    if (r.start < at) continue;
    out += text.slice(at, r.start);
    at = r.end;
  }
  return out + text.slice(at);
}

