#!/usr/bin/env node
/**
 * Compare a candidate artifact directory with a pinned reference. This gate is
 * deliberately fail-closed: without measured pixels and hard invariants there
 * is no accepted speed win. ffmpeg is used for PSNR/SSIM and VMAF when the
 * installed build exposes libvmaf.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, requireArg, run, sha256, writeJson, collectDirectoryFiles } from './lib/common.mjs';

const DEFAULTS = Object.freeze({ psnrDb: 35, ssim: 0.98, vmaf: 90 });
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov']);

async function mediaFiles(root) {
  const files = await collectDirectoryFiles(root);
  return files.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()) || VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

async function extractVideo(file, out) {
  await run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '120', path.join(out, 'frame-%06d.png')]);
  return (await collectDirectoryFiles(out)).filter((item) => item.endsWith('.png')).sort();
}

async function frameSet(root, scratch) {
  const files = await mediaFiles(root);
  const images = files.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())).sort();
  if (images.length) return images;
  const video = files.find((file) => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()));
  return video ? extractVideo(video, path.join(scratch, path.basename(root))) : [];
}

async function ffmpegMetric(filter, reference, candidate, scratch) {
  const log = path.join(scratch, `${filter}-${Math.random().toString(16).slice(2)}.log`);
  const filterWithLog = `${filter}=stats_file=${log}`;
  const result = await run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', reference, '-i', candidate, '-lavfi', `[0:v][1:v]${filterWithLog}`, '-f', 'null', '-']);
  let text = `${result.stdout}\n${result.stderr}`;
  try { text += `\n${await readFile(log, 'utf8')}`; } catch { /* VMAF may only log to stderr. */ }
  const matches = filter === 'psnr'
    ? [...text.matchAll(/(?:psnr_avg|average):([0-9.]+|inf)/gi)]
    : filter === 'ssim'
      ? [...text.matchAll(/All:([0-9.]+)/g)]
      : [...text.matchAll(/(?:mean|aggregate).*?(?:vmaf_score|score)[^0-9]*([0-9.]+)/gi)];
  await rm(log, { force: true }).catch(() => undefined);
  const token = matches.at(-1)?.[1] ?? null;
  const value = token?.toLowerCase() === 'inf' ? 1000 : (token === null ? null : Number(token));
  return { value, available: result.code === 0 && matches.length > 0, stderr: result.stderr.slice(-1000) };
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(createdAt|updatedAt|generatedAt|runId|jobId|artifactId)$/i.test(key))
    .map(([key, child]) => [key, scrub(child)]));
}

async function jsonDocuments(root) {
  const result = {};
  for (const file of await collectDirectoryFiles(root)) {
    if (!file.endsWith('.json') && !file.endsWith('.json.gz')) continue;
    try {
      let bytes = await readFile(file);
      if (file.endsWith('.gz')) bytes = (await import('node:zlib')).gunzipSync(bytes);
      const value = JSON.parse(bytes.toString('utf8'));
      const name = path.basename(file).replace(/\.gz$/, '');
      if (/trace|instance|result|manifest|sensor-frame|schedule/i.test(name) || /trace|schedule|frameMajor/i.test(JSON.stringify(value).slice(0, 500))) result[name] = scrub(value);
    } catch { /* binary or non-JSON artifact */ }
  }
  return result;
}

function compareSchedules(reference, candidate) {
  const paths = ['schedule', 'renderSpec.schedule', 'timing.schedule'];
  const find = (doc) => paths.map((key) => key.split('.').reduce((value, part) => value?.[part], doc)).find((value) => value !== undefined);
  const left = find(reference);
  const right = find(candidate);
  return { name: 'frame timing/synchronisation', passed: left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right), referenceSha256: left === undefined ? null : sha256(left), candidateSha256: right === undefined ? null : sha256(right) };
}

function compareGeometry(referenceDocs, candidateDocs) {
  const names = new Set([...Object.keys(referenceDocs), ...Object.keys(candidateDocs)].filter((name) => /trace|instance|sensor-frame/i.test(name)));
  const mismatches = [];
  for (const name of names) {
    if (referenceDocs[name] === undefined || candidateDocs[name] === undefined) { mismatches.push(name); continue; }
    if (JSON.stringify(referenceDocs[name]) !== JSON.stringify(candidateDocs[name])) mismatches.push(name);
  }
  return { name: 'geometry and actor poses', passed: names.size > 0 && mismatches.length === 0, compared: [...names].sort(), mismatches };
}

function frameCountInvariant(referenceFiles, candidateFiles, referenceDocs, candidateDocs) {
  const lookup = (docs) => Object.values(docs).map((doc) => doc?.schedule?.frameCount ?? doc?.frameCount ?? doc?.video?.frameCount).find((value) => Number.isFinite(Number(value)));
  const left = Number(lookup(referenceDocs) ?? referenceFiles.length);
  const right = Number(lookup(candidateDocs) ?? candidateFiles.length);
  return { name: 'frame count', passed: left > 0 && left === right, reference: left, candidate: right };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reference = path.resolve(requireArg(args, 'reference'));
  const candidate = path.resolve(requireArg(args, 'candidate'));
  const thresholds = { psnrDb: Number(args.get('min-psnr') ?? DEFAULTS.psnrDb), ssim: Number(args.get('min-ssim') ?? DEFAULTS.ssim), vmaf: Number(args.get('min-vmaf') ?? DEFAULTS.vmaf) };
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'simforge-quality-'));
  try {
    const [referenceFrames, candidateFrames, referenceDocs, candidateDocs] = await Promise.all([frameSet(reference, scratch), frameSet(candidate, scratch), jsonDocuments(reference), jsonDocuments(candidate)]);
    const paired = Math.min(referenceFrames.length, candidateFrames.length);
    const metricRows = [];
    for (let index = 0; index < paired; index += 1) {
      const [psnr, ssim, vmaf] = await Promise.all([
        ffmpegMetric('psnr', referenceFrames[index], candidateFrames[index], scratch),
        ffmpegMetric('ssim', referenceFrames[index], candidateFrames[index], scratch),
        ffmpegMetric('libvmaf', referenceFrames[index], candidateFrames[index], scratch),
      ]);
      metricRows.push({ index, psnr, ssim, vmaf });
    }
    const measured = (name) => metricRows.map((row) => row[name].value).filter(Number.isFinite);
    const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const quality = { psnrDb: average(measured('psnr')), ssim: average(measured('ssim')), vmaf: average(measured('vmaf')) };
    const invariants = [
      frameCountInvariant(referenceFrames, candidateFrames, referenceDocs, candidateDocs),
      compareSchedules(Object.values(referenceDocs).find((value) => value?.schedule) ?? {}, Object.values(candidateDocs).find((value) => value?.schedule) ?? {}),
      compareGeometry(referenceDocs, candidateDocs),
    ];
    const checks = {
      psnr: quality.psnrDb !== null && quality.psnrDb >= thresholds.psnrDb,
      ssim: quality.ssim !== null && quality.ssim >= thresholds.ssim,
      vmaf: quality.vmaf === null ? false : quality.vmaf >= thresholds.vmaf,
      invariants: invariants.every((item) => item.passed),
    };
    const reportBase = {
      schema: 'simforge.render-quality-gate/v1', generatedAt: new Date().toISOString(), reference, candidate,
      thresholds: { ...thresholds, vmafPolicy: 'required when ffmpeg exposes libvmaf; unavailable is a rejection, not an assumed pass' },
      measured: { framePairs: paired, quality, perFrame: metricRows }, invariants, checks,
      passed: paired > 0 && Object.values(checks).every(Boolean),
      rejectionReasons: [
        ...(paired === 0 ? ['no comparable pixel frames'] : []),
        ...(checks.psnr ? [] : [`PSNR below ${thresholds.psnrDb} dB or not measured`]),
        ...(checks.ssim ? [] : [`SSIM below ${thresholds.ssim} or not measured`]),
        ...(checks.vmaf ? [] : [`VMAF below ${thresholds.vmaf} or not measured in ffmpeg build`]),
        ...invariants.filter((item) => !item.passed).map((item) => `invariant failed: ${item.name}`),
      ],
    };
    const report = { ...reportBase, reportSha256: sha256(reportBase) };
    await writeJson(path.resolve(args.get('out') ?? path.join(candidate, 'quality-gate.json')), report);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 2;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

await main();
