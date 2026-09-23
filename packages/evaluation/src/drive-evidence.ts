export type ReasoningRecord =
  | { kind: 'text'; text: string }
  | { kind: 'choice'; question: string; choice: string; probabilities: Record<string, number>; confidence: number | null; candidates: string[] }
  | { kind: 'none' };
/** Recorded-evidence presentation only: no renderer, model, or simulation dependencies. */
// SVG layout's design viewport, not a sensor-calibration or camera-rig default.
const WIDTH = 512;
const HEIGHT = 384;
export function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A `steps.jsonl` reasoning value back into the typed record (`none` for anything unrecognised). */
export function reasoningRecord(value: unknown): ReasoningRecord {
  if (!value || typeof value !== 'object') return { kind: 'none' };
  const record = value as Record<string, unknown>;
  if (record['kind'] === 'text' && typeof record['text'] === 'string') return { kind: 'text', text: record['text'] };
  if (record['kind'] !== 'choice' || typeof record['question'] !== 'string' || typeof record['choice'] !== 'string') return { kind: 'none' };
  const raw = record['probabilities'];
  const probabilities = Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}).flatMap(([label, probability]) => (typeof probability === 'number' && Number.isFinite(probability) ? [[label, probability]] : [])));
  const candidates = Array.isArray(record['candidates']) ? record['candidates'].filter((candidate): candidate is string => typeof candidate === 'string') : Object.keys(probabilities);
  return { kind: 'choice', question: record['question'], choice: record['choice'], probabilities, confidence: typeof record['confidence'] === 'number' ? record['confidence'] : null, candidates };
}

export interface ReasoningTicker {
  /** One line: the model text, or `choice | question` for a choice record. */
  readonly text: string;
  /** Up to five candidate probabilities in [0, 1], in candidate order. */
  readonly bars: readonly { readonly label: string; readonly value: number }[];
}

export function reasoningTicker(reasoning: ReasoningRecord): ReasoningTicker {
  if (reasoning.kind === 'text') return { text: reasoning.text, bars: [] };
  if (reasoning.kind === 'none') return { text: 'no reasoning returned', bars: [] };
  // A forced single candidate carries no distribution; drawing 0 % bars would invent one.
  const scored = reasoning.candidates.filter((label) => Number.isFinite(reasoning.probabilities[label]));
  if (scored.length === 0) return { text: `${reasoning.choice} | probabilities unavailable`, bars: [] };
  const bars = scored.slice(0, 5).map((label) => ({ label, value: Math.max(0, Math.min(1, reasoning.probabilities[label]!)) }));
  return { text: `${reasoning.choice} | ${reasoning.question}`, bars };
}

/** Candidate probability bars stacked up from the bottom-right corner; sized for the 512×384 main camera and scaled with the pane. */
export function probabilityBarsSvg(bars: ReasoningTicker['bars'], width = WIDTH, height = HEIGHT): string {
  const scale = Math.min(width / WIDTH, height / HEIGHT);
  return bars.map((bar, index) => {
    const y = height - (40 + index * 18) * scale;
    const labelX = width - 242 * scale;
    const barX = width - 142 * scale;
    const barWidth = 110 * scale;
    const barHeight = 9 * scale;
    return `<text x="${labelX}" y="${y}" fill="white" font-size="${10 * scale}" font-family="monospace">${xml(bar.label.slice(0, 21))}</text><rect x="${barX}" y="${y - barHeight}" width="${barWidth}" height="${barHeight}" fill="#293344"/><rect x="${barX}" y="${y - barHeight}" width="${barWidth * bar.value}" height="${barHeight}" fill="#9fe8ff"/><text x="${width - 27 * scale}" y="${y}" fill="#dbeafe" font-size="${9 * scale}" font-family="monospace" text-anchor="end">${(bar.value * 100).toFixed(0)}%</text>`;
  }).join('');
}

type Extent = readonly [number, number, number, number];
type BevGrid = {
  readonly encoding: 'rle-u8';
  readonly width: number;
  readonly height: number;
  readonly extentM: Extent;
  readonly classes: readonly string[];
  readonly palette: readonly string[];
  readonly data: readonly number[];
};

function extent(value: unknown): value is Extent {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > value[0] && value[3] > value[1];
}

function bevGrid(value: unknown): BevGrid | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object') throw new Error('BEV grid must be an object');
  const grid = value as BevGrid;
  if (grid.encoding !== 'rle-u8' || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
    || grid.width < 1 || grid.width > 128 || grid.height < 1 || grid.height > 128 || !extent(grid.extentM)
    || !Array.isArray(grid.classes) || !grid.classes.every((label) => typeof label === 'string')
    || !Array.isArray(grid.palette) || grid.palette.length !== grid.classes.length
    || !grid.palette.every((color) => /^#[0-9a-f]{6}$/i.test(color))
    || !Array.isArray(grid.data) || grid.data.length % 2 !== 0) throw new Error('Invalid BEV grid metadata');
  let cells = 0;
  for (let i = 0; i < grid.data.length; i += 2) {
    const label = grid.data[i]!, count = grid.data[i + 1]!;
    if (!Number.isInteger(label) || label < 0 || label >= grid.classes.length || !Number.isInteger(count) || count < 1) throw new Error('Invalid BEV grid run');
    cells += count;
  }
  if (cells !== grid.width * grid.height) throw new Error('BEV grid runs do not cover the raster');
  return grid;
}

/** Shared by live/solo video and compose; consumes only model-declared extras.bev. */
export function bevInsetSvg(value: unknown, width = WIDTH, height = HEIGHT): string {
  if (value === undefined || value === null) return '';
  if (!value || typeof value !== 'object') throw new Error('BEV payload must be an object');
  const bev = value as Record<string, unknown>;
  if (bev['schema'] !== 'simforge.bev/v1' || bev['frame'] !== 'ego-x-forward-y-left') throw new Error('Unsupported BEV schema or frame');
  const map = bevGrid(bev['map']), occupancy = bevGrid(bev['occupancy']);
  const view = bev['viewExtentM'];
  if (!extent(view)) throw new Error('BEV viewExtentM is required');
  const [xmin, ymin, xmax, ymax] = view;
  const sx = 200 / (ymax - ymin), sy = 200 / (xmax - xmin);
  const point = (x: number, y: number): [number, number] => [(ymax - y) * sx, (xmax - x) * sy];
  const raster = (grid: BevGrid | null, obstaclesOnly: boolean): string => {
    if (!grid) return '';
    const [gxmin, gymin, gxmax, gymax] = grid.extentM;
    const dx = (gxmax - gxmin) / grid.height, dy = (gymax - gymin) / grid.width;
    const paths = grid.classes.map(() => '');
    let index = 0;
    for (let i = 0; i < grid.data.length; i += 2) {
      const label = grid.data[i]!, count = grid.data[i + 1]!;
      const name = grid.classes[label]!;
      const end = index + count;
      while (index < end) {
        const row = Math.floor(index / grid.width), col = index % grid.width;
        const length = Math.min(end - index, grid.width - col);
        if (!obstaclesOnly || !['empty', 'background', 'driveable', 'driveable_surface'].includes(name)) {
          const [x, y] = point(gxmax - row * dx, gymax - col * dy);
          paths[label] += `M${x.toFixed(2)} ${y.toFixed(2)}h${(length * dy * sx).toFixed(2)}v${(dx * sy).toFixed(2)}h${(-length * dy * sx).toFixed(2)}z`;
        }
        index += length;
      }
    }
    return paths.map((d, label) => d ? `<path d="${d}" fill="${grid.palette[label]}"/>` : '').join('');
  };
  const detections = bev['detections'];
  if (!Array.isArray(detections)) throw new Error('BEV detections must be an array');
  const boxes = detections.map((box: unknown) => {
    if (!Array.isArray(box) || box.length !== 7 || !box.every(Number.isFinite)) throw new Error('Invalid BEV detection');
    const [x, y, yaw, length, breadth] = box as [number, number, number, number, number, number, number];
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => point(x + a! * length / 2 * c - b! * breadth / 2 * s, y + a! * length / 2 * s + b! * breadth / 2 * c).join(',')).join(' ');
    return `<polygon points="${corners}" fill="none" stroke="#ff7e22" stroke-width="1.3"/>`;
  }).join('');
  const trajectory = bev['trajectory'];
  if (trajectory !== undefined && (!Array.isArray(trajectory) || !trajectory.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) throw new Error('Invalid ego-frame BEV trajectory');
  const plan = (trajectory as readonly (readonly [number, number])[] | undefined)?.map(([x, y]) => point(x, y).join(',')).join(' ') ?? '';
  const [egoX, egoY] = point(0, 0);
  const gridLines = [10, 20, 30].filter((x) => x > xmin && x < xmax).map((x) => {
    const y = point(x, 0)[1];
    return `<path d="M0 ${y}H200" stroke="#64748b" stroke-width=".5" stroke-dasharray="2 3"/><text x="2" y="${y - 2}" font-size="8" fill="#172033">${x}m</text>`;
  }).join('');
  const legendGrid = map ?? occupancy;
  const legend = legendGrid?.classes.map((label, i) => ({ label, color: legendGrid.palette[i]! })).filter(({ label }) => label !== 'background' && label !== 'empty').slice(0, 6).map(({ label, color }, i) => {
    const x = 10 + (i % 3) * 68, y = 248 + Math.floor(i / 3) * 11;
    return `<rect x="${x}" y="${y - 7}" width="7" height="7" fill="${color}"/><text x="${x + 10}" y="${y}" font-size="8" fill="#e2e8f0">${xml(label.replace('driveable_surface', 'road').replace('road_', '').replaceAll('_', ' ').slice(0, 10))}</text>`;
  }).join('') ?? '';
  const scale = Math.min(width / WIDTH, height / HEIGHT);
  const note = Array.isArray(bev['cameraIds']) ? `${bev['cameraIds'].length} cameras | ${String(bev['coverage'] ?? '').includes('out-of-training') ? 'out-of-training rig' : 'model prediction'}` : 'model prediction';
  return `<g transform="translate(8 ${height - 280 * scale - 8}) scale(${scale})" font-family="monospace">
    <rect width="220" height="280" rx="5" fill="#07101b" fill-opacity=".94" stroke="#91b9ca" stroke-width=".7"/>
    <text x="10" y="15" font-size="11" fill="white">MODEL BEV | forward up</text>
    <text x="10" y="28" font-size="8" fill="#b9d7e5">${xml(note)}</text>
    <svg x="10" y="35" width="200" height="200" viewBox="0 0 200 200" overflow="hidden">
      <rect width="200" height="200" fill="#263142"/>
      ${raster(occupancy, false)}${raster(map, false)}${map ? raster(occupancy, true) : ''}${gridLines}${boxes}
      <polyline points="${plan}" fill="none" stroke="#111827" stroke-width="4"/><polyline points="${plan}" fill="none" stroke="#ffe55d" stroke-width="2"/>
      <path d="M${egoX - 4} ${egoY - 1}L${egoX} ${egoY - 10}L${egoX + 4} ${egoY - 1}z" fill="#38d8ff" stroke="#13273d"/>
    </svg>
    ${legend}<text x="10" y="274" font-size="8" fill="#ff9a51">orange boxes / colour occupancy</text>
    <path d="M160 270h12" stroke="#ffe55d" stroke-width="2"/><text x="177" y="274" font-size="8" fill="#ffe55d">plan</text>
  </g>`;
}
export interface ModelHealthAssessment {
  readonly healthy: boolean;
  readonly reasons: readonly string[];
}

/** The promotion rule `finish()` records and `verify` recomputes: no closed-loop fallbacks, no invalid plans. */
export function assessDriveModelHealth(health: Record<string, unknown> | undefined): ModelHealthAssessment {
  const reasons: string[] = [];
  if (!health) {
    reasons.push('model health was not reported');
  } else {
    const fallbacks = health['fallbacks'];
    if (fallbacks && typeof fallbacks === 'object' && Number((fallbacks as Record<string, unknown>)['closedLoop'] ?? 0) > 0) reasons.push('closed-loop fallback decisions were applied');
    if (Number(health['invalidPlans'] ?? 0) > 0) reasons.push('invalid plans were returned');
  }
  return { healthy: reasons.length === 0, reasons };
}
