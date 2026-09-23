import sharp from 'sharp';

import { HEIGHT, WIDTH } from './profiles.js';
import { bevInsetSvg, probabilityBarsSvg, reasoningTicker, xml } from '@simforge-oss/evaluation/drive-evidence';
import type { ReasoningRecord } from '@simforge-oss/evaluation/drive-evidence';

export interface HudState {
  readonly policy: string;
  readonly speedMps: number;
  readonly latencyMs: number;
  readonly step: number;
  readonly tS: number;
  readonly reasoning: ReasoningRecord;
  readonly trajectory: readonly number[][] | null;
  readonly extras?: Readonly<Record<string, unknown>>;
}


/** Composite a deterministic, readable overlay without changing model pixels. */
export async function annotateFrame(rawRgba: Buffer, state: HudState): Promise<Buffer> {
  const bev = bevInsetSvg(state.extras?.['bev']);
  const prediction = bev ? [] : state.trajectory ?? [];
  const minX = Math.min(0, ...prediction.map((point) => point[0] ?? 0));
  const maxX = Math.max(1, ...prediction.map((point) => point[0] ?? 0));
  const minY = Math.min(-1, ...prediction.map((point) => point[1] ?? 0));
  const maxY = Math.max(1, ...prediction.map((point) => point[1] ?? 0));
  const poly = prediction.map((point) => `${260 + (((point[0] ?? 0) - minX) / Math.max(1e-6, maxX - minX)) * 220},${350 - (((point[1] ?? 0) - minY) / Math.max(1e-6, maxY - minY)) * 100}`).join(' ');
  const reason = reasoningTicker(state.reasoning);
  const svg = `<svg width="${WIDTH}" height="${HEIGHT}">
    <rect x="8" y="8" width="${WIDTH - 16}" height="50" rx="4" fill="#000" fill-opacity=".78"/>
    <text x="16" y="27" fill="white" font-size="12" font-family="monospace">${xml(state.policy)} | v=${state.speedMps.toFixed(2)}m/s | ${state.latencyMs.toFixed(1)}ms</text>
    <text x="16" y="46" fill="#b6e3ff" font-size="10" font-family="monospace">step=${state.step} t=${state.tS.toFixed(2)}s | ${xml(reason.text.slice(0, 72))}</text>
    ${bev ? '' : `<rect x="250" y="245" width="250" height="130" rx="4" fill="#000" fill-opacity=".62"/>
    <polyline points="${poly}" fill="none" stroke="#ffdc5e" stroke-width="2"/>
    <circle cx="260" cy="350" r="3" fill="#ff5555"/>`}
    ${probabilityBarsSvg(reason.bars)}
    ${bev}
  </svg>`;
  return sharp(rawRgba, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).composite([{ input: Buffer.from(svg) }]).raw().toBuffer();
}
