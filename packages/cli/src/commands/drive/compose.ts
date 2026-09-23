import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { CliError, EXIT } from '../../errors.js';
import { emit } from '../../output.js';
import { bevInsetSvg, probabilityBarsSvg, reasoningRecord, reasoningTicker, xml } from '@simforge-oss/evaluation/drive-evidence';
import { readRunJson } from './run-dir.js';

const FPS = 10;
const DEFAULT_PANE_WIDTH = 512;
const DEFAULT_PANE_HEIGHT = 384;

type JsonObject = Record<string, unknown>;

type FrameInfo = {
  readonly file: string;
  readonly step: number;
};

/** The `steps.jsonl` fields the pane HUD reads (see docs/engineering/drive-bench.md). */
type StepRow = {
  readonly tS?: unknown;
  readonly pose?: unknown;
  readonly reasoning?: unknown;
  readonly latencyMs?: unknown;
  readonly miss?: unknown;
  readonly extras?: unknown;
};

type Score = {
  readonly drivingScore: number | null;
  readonly routeCompletion: number | null;
  readonly infractions: Record<string, number>;
  readonly meanLatencyMs: number | null;
  readonly misses: number | null;
};

type Pane = {
  readonly runDir: string;
  readonly policyId: string;
  readonly run: JsonObject;
  readonly score: Score;
  readonly frames: Map<number, FrameInfo>;
  readonly steps: Map<number, StepRow>;
};

export interface ComposeOptions {
  readonly runDirs: readonly string[];
  readonly out: string;
  readonly pretty?: boolean;
  readonly emitResult?: boolean;
  /** Two panes per run: unchanged raw RGB beside the explicitly recorded enhanced pass. */
  readonly appearance?: boolean;
}

export interface ComposeReport {
  readonly schema: 'simforge.drive-heat-report/v1';
  readonly video: string;
  readonly runs: readonly {
    readonly runDir: string;
    readonly policy: string;
    readonly score: Score;
    readonly frameCount: number;
  }[];
  readonly synchronizedTicks: number;
  readonly layout: { readonly rows: number; readonly columns: number; readonly paneWidth: number; readonly paneHeight: number; readonly fps: number };
  readonly aggregate: {
    readonly drivingScore: number | null;
    readonly routeCompletion: number | null;
    readonly infractions: Record<string, number>;
    readonly meanLatencyMs: number | null;
    readonly misses: number | null;
  };
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

/** `score.json` (simforge.eval-score/v1) plus the per-decision latency mean from `steps.jsonl`. */
function scoreFromDocument(document: JsonObject, steps: ReadonlyMap<number, StepRow>): Score {
  const infractionsValue = object(document['infractions']) ?? {};
  const infractions: Record<string, number> = {};
  for (const [key, value] of Object.entries(infractionsValue)) {
    const number = finite(value);
    if (number !== null) infractions[key] = number;
  }
  const stepLatencies = [...steps.values()].map((row) => finite(row.latencyMs)).filter((value): value is number => value !== null);
  return {
    drivingScore: finite(document['drivingScore']),
    routeCompletion: finite(document['routeCompletion']),
    infractions,
    meanLatencyMs: stepLatencies.length > 0 ? stepLatencies.reduce((sum, value) => sum + value, 0) / stepLatencies.length : null,
    misses: finite(document['deadlineMisses']),
  };
}

async function readJson(file: string): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  } catch (error) {
    throw new CliError('read_failed', `could not read JSON ${file}: ${error instanceof Error ? error.message : String(error)}`, { path: file });
  }
  const parsed = object(value);
  if (!parsed) throw new CliError('bad_value', `${file} must contain a JSON object`, { path: file });
  return parsed;
}

async function readSteps(runDir: string): Promise<Map<number, StepRow>> {
  const file = path.join(runDir, 'steps.jsonl');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new CliError('file_not_found', `run is missing steps.jsonl: ${error instanceof Error ? error.message : String(error)}`, { path: file });
  }
  const rows = new Map<number, StepRow>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new CliError('bad_value', `invalid JSON in ${file} at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`, { path: file });
    }
    const row = object(value);
    const step = finite(row?.['step']);
    if (!row || step === null || !Number.isInteger(step) || step < 0) continue;
    rows.set(step, row as StepRow);
  }
  return rows;
}

async function findFrameDirectory(runDir: string, enhanced = false): Promise<string> {
  const root = path.join(runDir, enhanced ? 'frames-enhanced' : 'frames');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new CliError('file_not_found', `run is missing frames/: ${error instanceof Error ? error.message : String(error)}`, { path: root });
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (directories.length === 0) throw new CliError('bad_value', `run has no frame sensor directories: ${root}`, { path: root });
  // The runner always records the main (front wide) camera; other sensors are policy rigs.
  const preferred = ['camera_front_wide_120fov', 'camera_front_tele_30fov'];
  const sensor = preferred.find((name) => directories.includes(name)) ?? directories.sort()[0]!;
  return path.join(root, sensor);
}

async function readFrames(runDir: string, enhanced = false): Promise<Map<number, FrameInfo>> {
  const directory = await findFrameDirectory(runDir, enhanced);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const frames = new Map<number, FrameInfo>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
    const match = /^(\d+)\.png$/i.exec(entry.name);
    if (!match) continue;
    const step = Number(match[1]);
    if (!Number.isSafeInteger(step) || step < 0) continue;
    frames.set(step, { file: path.join(directory, entry.name), step });
  }
  if (frames.size === 0) throw new CliError('bad_value', `run has no numbered PNG frames in ${directory}`, { path: directory });
  return frames;
}

async function loadPane(runDir: string, stream?: 'raw' | 'enhanced'): Promise<Pane> {
  const resolved = path.resolve(runDir);
  const run = await readRunJson(resolved).catch(async (error: unknown) => {
    if (error instanceof CliError) throw error;
    throw new CliError('file_not_found', `run is missing run.json: ${error instanceof Error ? error.message : String(error)}`, { path: path.join(resolved, 'run.json') });
  });
  const [scoreDocument, physicalFrames, steps] = await Promise.all([
    readJson(path.join(resolved, 'score.json')),
    readFrames(resolved, stream === 'enhanced'),
    readSteps(resolved),
  ]);
  // Drive writes warm-up renders before decision-tick renders. Re-index those
  // files from zero so the composed timeline is the decision timeline rather
  // than a policy-specific camera-history prelude.
  const warmupFrames = Math.max(0, Math.floor(finite(run['warmupFrames']) ?? 0));
  const frames = new Map<number, FrameInfo>();
  for (const [physicalTick, frame] of physicalFrames) {
    if (physicalTick < warmupFrames) continue;
    const tick = physicalTick - warmupFrames;
    frames.set(tick, { file: frame.file, step: tick });
  }
  if (frames.size === 0) {
    for (const [physicalTick, frame] of physicalFrames) frames.set(physicalTick, frame);
  }
  const policyId = stringValue(run['policyId']);
  if (!policyId) throw new CliError('bad_value', `run.json has no policyId: ${resolved}`, { path: path.join(resolved, 'run.json') });
  const input = object(run['appearance']);
  const inputLabel = stringValue(input?.['policyInput']) ?? 'raw';
  const label = stream ? `${policyId} · ${stream} (policy ${inputLabel})`
    : input ? `${policyId} · policy ${inputLabel}` : policyId;
  return { runDir: resolved, policyId: label, run, score: scoreFromDocument(scoreDocument, steps), frames, steps };
}

function hudSvg(width: number, height: number, pane: Pane, tick: number): Buffer {
  const row = pane.steps.get(tick);
  const reason = reasoningTicker(reasoningRecord(row?.reasoning));
  const speed = finite(object(row?.pose)?.['speedMps']);
  const latency = finite(row?.latencyMs);
  const miss = row?.miss === true || row?.miss === 1 ? ' MISS' : '';
  const score = pane.score.drivingScore === null ? '—' : pane.score.drivingScore.toFixed(3);
  const speedText = speed === null ? '—' : `${speed.toFixed(2)}m/s`;
  const latencyText = latency === null ? '—' : `${latency.toFixed(1)}ms`;
  const topHeight = Math.min(72, Math.max(54, Math.round(height * 0.18)));
  const textSize = Math.max(10, Math.round(width / 52));
  const smallSize = Math.max(9, textSize - 2);
  const reasonWidth = Math.max(24, Math.floor(width / (textSize * 0.58)) - 2);
  const reasoningLine = xml(truncate(reason.text, reasonWidth));
  const tS = finite(row?.tS) ?? tick / FPS;
  const bev = bevInsetSvg(object(row?.extras)?.['bev'], width, height);
  return Buffer.from(`<svg width="${width}" height="${height}"><rect x="6" y="6" width="${width - 12}" height="${topHeight}" rx="4" fill="#000" fill-opacity=".80"/><text x="14" y="${textSize + 11}" fill="#fff" font-family="monospace" font-size="${textSize}">${xml(pane.policyId)} | speed=${speedText} | score=${score}${miss}</text><text x="14" y="${textSize + 29}" fill="#b9e7ff" font-family="monospace" font-size="${smallSize}">tick=${tick} t=${tS.toFixed(2)}s | latency=${latencyText}</text><text x="14" y="${textSize + 46}" fill="#fff" font-family="monospace" font-size="${smallSize}">${reasoningLine}</text>${probabilityBarsSvg(reason.bars, width, height)}${bev}</svg>`);
}

async function annotateFrame(source: FrameInfo, target: string, pane: Pane, tick: number, width: number, height: number): Promise<void> {
  await sharp(source.file)
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: hudSvg(width, height, pane, tick) }])
    .png()
    .toFile(target);
}

function layoutFor(count: number): { rows: number; columns: number } {
  if (count <= 1) return { rows: 1, columns: 1 };
  if (count <= 4) {
    const columns = Math.min(2, count);
    return { rows: Math.ceil(count / columns), columns };
  }
  return { rows: 1, columns: count };
}

function xstackLayout(count: number): string {
  if (count === 2) return '0_0|w0_0';
  if (count <= 4) return '0_0|w0_0|0_h0|w0_h0';
  const cells: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = index === 0 ? '0' : Array.from({ length: index }, (_, prior) => `w${prior}`).join('+');
    cells.push(`${x}_0`);
  }
  return cells.join('|');
}

async function runFfmpeg(panes: readonly string[], out: string, width: number, height: number): Promise<void> {
  const ffmpeg = process.env['SIMFORGE_FFMPEG_BINARY'] ?? process.env['SIMFORGE_FFMPEG'] ?? 'ffmpeg';
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const directory of panes) args.push('-framerate', String(FPS), '-start_number', '0', '-i', path.join(directory, '%06d.png'));
  const labels = panes.map((_, index) => `[${index}:v]scale=${width}:${height}:flags=lanczos[p${index}]`);
  const inputs = panes.map((_, index) => `[p${index}]`).join('');
  const filter = panes.length === 1
    ? `[0:v]scale=${width}:${height}:flags=lanczos[v]`
    : `${labels.join(';')};${inputs}xstack=inputs=${panes.length}:layout=${xstackLayout(panes.length)}:fill=black[v]`;
  args.push('-filter_complex', filter, '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const errors: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => errors.push(String(chunk)));
  const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new CliError('render_failed', `ffmpeg failed composing heatmap (${signal ?? code}): ${errors.join('').trim() || 'no diagnostics'}`, { path: out });
}

function average(values: readonly (number | null)[]): number | null {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return finiteValues.length > 0 ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length : null;
}

function sumInfractions(scores: readonly Score[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const score of scores) for (const [key, value] of Object.entries(score.infractions)) result[key] = (result[key] ?? 0) + value;
  return result;
}

function reportMarkdown(report: ComposeReport): string {
  const lines = [
    '# SimForge drive heat',
    '',
    `Video: \`${report.video}\``,
    '',
    `Synchronized ticks: ${report.synchronizedTicks} at ${report.layout.fps} Hz (${report.layout.columns}×${report.layout.rows}, ${report.layout.paneWidth}×${report.layout.paneHeight} per pane).`,
    '',
    '| Policy | Driving score | Route completion | Infractions | Mean latency (ms) | Misses |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const run of report.runs) {
    const infractionCount = Object.values(run.score.infractions).reduce((sum, value) => sum + value, 0);
    lines.push(`| ${run.policy} | ${run.score.drivingScore === null ? '—' : run.score.drivingScore.toFixed(3)} | ${run.score.routeCompletion === null ? '—' : run.score.routeCompletion.toFixed(3)} | ${infractionCount} | ${run.score.meanLatencyMs === null ? '—' : run.score.meanLatencyMs.toFixed(1)} | ${run.score.misses === null ? '—' : run.score.misses} |`);
  }
  lines.push('', '## Aggregate', '', `- Driving score (mean): ${report.aggregate.drivingScore === null ? '—' : report.aggregate.drivingScore.toFixed(3)}`, `- Route completion (mean): ${report.aggregate.routeCompletion === null ? '—' : report.aggregate.routeCompletion.toFixed(3)}`, `- Mean latency: ${report.aggregate.meanLatencyMs === null ? '—' : `${report.aggregate.meanLatencyMs.toFixed(1)} ms`}`, `- Deadline misses: ${report.aggregate.misses === null ? '—' : report.aggregate.misses}`, `- Infractions: ${Object.entries(report.aggregate.infractions).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`, '');
  return `${lines.join('\n')}\n`;
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temporary = `${file}.partial-${process.pid}`;
  await fs.writeFile(temporary, contents, 'utf8');
  await fs.rename(temporary, file);
}

export async function compose(options: ComposeOptions): Promise<number> {
  if (options.runDirs.length < 1) throw new CliError('missing_argument', 'drive compose requires at least one run directory');
  if (options.runDirs.length * (options.appearance ? 2 : 1) > 16) throw new CliError('bad_value', 'drive compose accepts at most 16 panes', { path: 'runDir' });
  const out = path.resolve(options.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const panes = await Promise.all(options.runDirs.flatMap((runDir) => options.appearance
    ? [loadPane(runDir, 'raw'), loadPane(runDir, 'enhanced')] : [loadPane(runDir)]));
  const firstFrame = panes[0]!.frames.values().next().value as FrameInfo | undefined;
  if (!firstFrame) throw new CliError('bad_value', `run has no frame for ${panes[0]!.runDir}`, { path: panes[0]!.runDir });
  const metadata = await sharp(firstFrame.file).metadata();
  const paneWidth = Math.max(2, (metadata.width ?? DEFAULT_PANE_WIDTH) & ~1);
  const paneHeight = Math.max(2, (metadata.height ?? DEFAULT_PANE_HEIGHT) & ~1);
  const commonTicks = new Set(panes[0]!.frames.keys());
  for (const pane of panes.slice(1)) {
    for (const tick of [...commonTicks]) {
      if (!pane.frames.has(tick)) commonTicks.delete(tick);
    }
  }
  const sharedTicks = [...commonTicks].sort((a, b) => a - b);
  if (sharedTicks.length === 0) throw new CliError('bad_value', 'runs do not share any frame ticks');
  const contiguousTicks: number[] = [];
  const start = sharedTicks[0]!;
  for (const tick of sharedTicks) {
    if (tick !== start + contiguousTicks.length) break;
    contiguousTicks.push(tick);
  }
  if (contiguousTicks.length === 0) throw new CliError('bad_value', 'runs have no contiguous frame ticks from their first shared tick');
  const temporary = await fs.mkdtemp(path.join(path.dirname(out), '.simforge-heat-'));
  try {
    const paneDirectories: string[] = [];
    for (let paneIndex = 0; paneIndex < panes.length; paneIndex += 1) {
      const pane = panes[paneIndex]!;
      const directory = path.join(temporary, `pane-${paneIndex}`);
      await fs.mkdir(directory, { recursive: true });
      paneDirectories.push(directory);
      for (let frameIndex = 0; frameIndex < contiguousTicks.length; frameIndex += 1) {
        const tick = contiguousTicks[frameIndex]!;
        const source = pane.frames.get(tick);
        if (!source) throw new CliError('bad_value', `run ${pane.runDir} is missing frame tick ${tick}`);
        await annotateFrame(source, path.join(directory, `${String(frameIndex).padStart(6, '0')}.png`), pane, tick, paneWidth, paneHeight);
      }
    }
    await runFfmpeg(paneDirectories, out, paneWidth, paneHeight);
    const layout = layoutFor(panes.length);
    // Appearance panes duplicate a single policy episode, not independent scores.
    const scores = panes.filter((_, index) => !options.appearance || index % 2 === 0).map((pane) => pane.score);
    const report: ComposeReport = {
      schema: 'simforge.drive-heat-report/v1',
      video: out,
      runs: panes.map((pane) => ({ runDir: pane.runDir, policy: pane.policyId, score: pane.score, frameCount: pane.frames.size })),
      synchronizedTicks: contiguousTicks.length,
      layout: { ...layout, paneWidth, paneHeight, fps: FPS },
      aggregate: {
        drivingScore: average(scores.map((score) => score.drivingScore)),
        routeCompletion: average(scores.map((score) => score.routeCompletion)),
        infractions: sumInfractions(scores),
        meanLatencyMs: average(scores.map((score) => score.meanLatencyMs)),
        misses: scores.every((score) => score.misses === null) ? null : scores.reduce<number>((sum, score) => sum + (score.misses ?? 0), 0),
      },
    };
    const reportJson = path.join(path.dirname(out), 'report.json');
    const reportMd = path.join(path.dirname(out), 'report.md');
    await writeAtomic(reportJson, `${JSON.stringify(report, null, 2)}\n`);
    await writeAtomic(reportMd, reportMarkdown(report));
    if (options.emitResult !== false) {
      emit({ ok: true, video: out, report: reportJson, reportMarkdown: reportMd, synchronizedTicks: report.synchronizedTicks, panes: report.runs.map((run) => run.policy), layout: report.layout }, { pretty: options.pretty ?? false });
    }
    return EXIT.ok;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
