import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PromotionEpisode, PromotionReport } from '../../packages/evaluation/src/promote.js';
import { compareNativeEpisodeTraces } from '../../packages/evaluation/src/campaign.js';

const argv = process.argv.slice(2);
const promotionDir = argv[0] ? path.resolve(argv[0]) : null;
if (!promotionDir) throw new Error('usage: pnpm exec tsx tools/release-bundle/build.mts PROMOTION_DIR [--id v1] [--out ROOT] [--training-run DIR] [--teacher TORCH_REF] [--recorded-replay RECEIPT.json]');
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i += 2) {
  if (!['--id', '--out', '--training-run', '--teacher', '--recorded-replay'].includes(argv[i]!) || !argv[i + 1]) throw new Error(`unknown or incomplete option: ${argv[i]}`);
  flags[argv[i]!.slice(2)] = argv[i + 1]!;
}
const id = flags.id ?? 'v1';
if (!/^[a-zA-Z0-9_.-]+$/.test(id)) throw new Error('invalid bundle id');
const out = path.join(flags.out ?? path.join(os.homedir(), 'simforge-assets/runs/drive/training/release'), `training-poc-${id}`);
await mkdir(path.dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
const reportBytes = await readFile(path.join(promotionDir, 'promotion.json'));
const report = JSON.parse(reportBytes.toString()) as PromotionReport;
if (report.schema !== 'simforge.promotion/v1') throw new Error('not a promotion directory');
const inventory: { path: string; bytes: number; sha256: string }[] = [];
async function record(relative: string): Promise<void> {
  const bytes = await readFile(path.join(out, relative));
  inventory.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
async function copy(source: string, relative: string): Promise<void> {
  await mkdir(path.dirname(path.join(out, relative)), { recursive: true });
  await copyFile(source, path.join(out, relative)); await record(relative);
}
async function json(relative: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.join(out, relative)), { recursive: true });
  await writeFile(path.join(out, relative), `${JSON.stringify(value, null, 2)}\n`); await record(relative);
}
for (const file of ['promotion.json', 'score.json', 'report.md', 'campaign.json', 'panel.json']) await copy(path.join(promotionDir, file), file);
for (const file of await readdir(path.join(promotionDir, 'configs'))) await copy(path.join(promotionDir, 'configs', file), `configs/${file}`);
for (const file of await readdir(path.join(promotionDir, 'sources'))) await copy(path.join(promotionDir, 'sources', file), `sources/${file}`);
try { await copy(path.join(promotionDir, 'verification.json'), 'verification.json'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await json('checkpoints/refs.json', { candidate: report.policy, entry: report.checkpoint, comparisons: report.comparison.map((p) => p.policy), policy: 'checkpoint refs and SHA-256s, never silently copied/retrained weights' });
const evidence = new Set<string>();
for (const policy of report.comparison) for (const episode of policy.episodes) if (episode.runDir) evidence.add(episode.runDir);
for (const replay of report.determinism) if (replay.rerunDir) evidence.add(replay.rerunDir);
const runs: { source: string; bundle: string }[] = [];
for (const [index, source] of [...evidence].entries()) {
  const bundle = `per-seed/${String(index).padStart(3, '0')}-${path.basename(source)}`;
  runs.push({ source, bundle });
  for (const file of ['trace.jsonl', 'steps.jsonl', 'score.json', 'run.json', 'result.json', 'log.txt']) {
    try { await copy(path.join(source, file), `${bundle}/${file}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await json(`${bundle}/${file}.missing.json`, { status: 'missing', source: path.join(source, file) }); }
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(source, 'result.json'), 'utf8')) as { artifacts: { path: string; sha256: string; bytes: number }[] };
    for (const artifact of manifest.artifacts) {
      const copied = inventory.find((item) => item.path === `${bundle}/${artifact.path}`);
      if (copied && (copied.sha256 !== artifact.sha256 || copied.bytes !== artifact.bytes)) throw new Error(`source artifact changed after evaluation: ${source}/${artifact.path}`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
await json('manifests/runs.json', { runs, note: 'Source result manifests retain original artifact identities. PNG sequences and unselected videos are external references, not falsely declared bundled.' });
let trainingFiles = 0;
if (flags['training-run']) for (const file of await readdir(flags['training-run'])) {
  if (!/(config|provenance|metrics|curve|dashboard|preregistration|statistics|training-summary)/i.test(file) || !(await stat(path.join(flags['training-run'], file))).isFile()) continue;
  await copy(path.join(flags['training-run'], file), `training/${file}`); trainingFiles++;
}
if (!trainingFiles) await json('training/missing.json', { status: 'missing', reason: 'training run/learning curves not supplied; pass --training-run, never synthesize a learning curve' });
const candidate = report.comparison[0]!;
const test = candidate.episodes.find((e) => e.source === 'test');
const bcPolicy = JSON.parse(await readFile(path.join(promotionDir, 'campaign.json'), 'utf8'))['bcBaseline'] as string | null;
const bc = report.comparison.find((p) => p.policy === bcPolicy);
const teacher = report.comparison.find((p) => p.policy === flags.teacher);
const matchTeacher = (episode: PromotionEpisode | undefined) => episode && teacher?.episodes.find((e) => e.entryId === episode.entryId)?.runDir;
const candidateData = (report.checkpoint as { provenance?: { dataset?: { kind?: string }[] } } | null)?.provenance?.dataset;
const candidateLabel = candidateData?.some((source) => source.kind === 'student-visited') ? 'DAgger' : 'Candidate';
let worst: PromotionEpisode | undefined;
let worstLabel: string | undefined;
let worstPolicy: string | undefined;
const considered = new Set<string>();
for (const owner of [{ result: candidate, label: candidateLabel }, { result: bc, label: 'BC baseline' }, { result: teacher, label: 'Frozen teacher' }, { result: report.comparison.find((p) => p.policy === 'scripted'), label: 'Scripted' }]) {
  if (!owner.result || considered.has(owner.result.policy)) continue;
  considered.add(owner.result.policy);
  const failures: PromotionEpisode[] = [];
  for (const episode of owner.result.episodes) {
    if (!episode.score || !episode.runDir) continue;
    const trace = (await readFile(path.join(episode.runDir, 'trace.jsonl'), 'utf8')).trimEnd();
    const summary = JSON.parse(trace.slice(trace.lastIndexOf('\n') + 1)).summary;
    if (['collision', 'offroad', 'red_crossing'].includes(summary?.termReason) || episode.score.terminal.collision || (episode.score['alpasim-style-score']?.hardFailures.length ?? 0) > 0) failures.push(episode);
  }
  worst = failures.sort((a, b) => a.score!.drivingScore - b.score!.drivingScore || a.entryId.localeCompare(b.entryId))[0];
  if (worst) { worstLabel = owner.label; worstPolicy = owner.result.policy; break; }
}
const worstComparison = worstPolicy === teacher?.policy ? candidate : teacher;
const heldout = candidate.episodes.find((e) => e.source === 'test' && e.mapId !== test?.mapId);
const exact = report.determinism.find((r) => r.match);
const replayLabel = 'recorded-action replay (renderer RGB nondeterministic; not a model re-inference)';
let recordedReplay: { sourceRun: string; directory: string; pixelIdentical: boolean } | undefined;
if (!exact && flags['recorded-replay']) {
  const file = path.resolve(flags['recorded-replay']);
  const replay = JSON.parse(await readFile(file, 'utf8'));
  if (replay.schema !== 'simforge.recorded-action-replay/v1' || replay.label !== replayLabel || replay.isModelReInference !== false || replay.promotable !== false || replay.sourceRun !== test?.runDir) throw new Error('recorded replay must explicitly name the first frozen candidate hazard and disclaim model re-inference');
  const originalTrace = await readFile(path.join(replay.sourceRun, 'trace.jsonl'), 'utf8');
  const replayTrace = await readFile(path.join(path.dirname(file), 'trace.jsonl'), 'utf8');
  const proof = compareNativeEpisodeTraces(originalTrace, replayTrace);
  if (!proof.match || proof.original.stateDigest !== replay.worldActionChainDigest || createHash('sha256').update(originalTrace).digest('hex') !== replay.sourceTraceSha256 || createHash('sha256').update(replayTrace).digest('hex') !== replay.replayTraceSha256) throw new Error('recorded replay world/action or native-chain identity differs');
  if (path.resolve(replay.video) !== path.join(path.dirname(file), 'drive.mp4') || createHash('sha256').update(await readFile(replay.video)).digest('hex') !== replay.videoSha256) throw new Error('recorded replay video identity differs');
  await copy(file, 'replay/replay.json');
  await copy(path.join(path.dirname(file), 'trace.jsonl'), 'replay/trace.jsonl');
  recordedReplay = { sourceRun: replay.sourceRun, directory: path.dirname(file), pixelIdentical: proof.pixelIdentical };
}
const timelapse = flags['training-run'] ? path.join(flags['training-run'], 'training-timelapse.mp4') : null;
const slots: { id: string; why: string; dirs: (string | null | undefined)[]; video?: string | null; label?: string }[] = [
  { id: '01-worst-failure', why: 'candidate, then primary BC, teacher, scripted priority; lowest drivingScore native collision/corridor/signal or named hard failure; id breaks ties', dirs: [worst?.runDir, worstComparison?.episodes.find((e) => e.entryId === worst?.entryId)?.runDir], label: `${worstLabel ?? 'No observed'} failure (left) | ${worstComparison === teacher ? 'Frozen teacher' : candidateLabel} matched seed (right)` },
  { id: '02-exact-replay', why: recordedReplay ? replayLabel : 'first passing world/policy rerun; pixel identity not implied', dirs: recordedReplay ? [recordedReplay.sourceRun, recordedReplay.directory] : [exact?.originalDir, exact?.rerunDir], label: recordedReplay ? replayLabel : 'Original (left) | model re-inference (right): exact world/actions; pixels not guaranteed' },
  { id: '03-held-out-map', why: 'first hazard on the second frozen held-out geography', dirs: [heldout?.runDir, matchTeacher(heldout)], label: `${candidateLabel} held-out map (left) | frozen teacher (right)` },
  { id: '04-teacher-versus-student', why: 'first frozen hazard matched to explicitly named teacher, current rendering pipeline', dirs: [matchTeacher(test), test?.runDir], label: `Frozen teacher (left) | ${candidateLabel} (right)` },
  { id: '05-bc-versus-dagger', why: 'first hazard matched to explicitly named primary BC baseline', dirs: [bc?.episodes.find((e) => e.entryId === test?.entryId)?.runDir, test?.runDir], label: `Primary BC baseline (left) | ${candidateLabel} (right)` },
  { id: '06-training-timelapse', why: 'chronological actual student dashboard PNG sequence; not synthesized rollout imagery', dirs: [], video: timelapse },
];
await mkdir(path.join(out, 'videos'), { recursive: true });
const slotReceipts = [];
for (const slot of slots) {
  const sources = slot.video !== undefined ? [slot.video] : slot.dirs.map((dir) => dir ? path.join(dir, 'drive.mp4') : null);
  let available = sources.every(Boolean);
  if (available) for (const source of sources) try { await stat(source!); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; available = false; }
  const relative = `videos/${slot.id}.mp4`;
  const output = path.join(out, relative);
  if (available && sources.length === 1) {
    await copyFile(sources[0]!, output);
  } else if (available) {
    let composite = '[0:v]scale=512:384,setsar=1[a];[1:v]scale=512:384,setsar=1[b];[a][b]hstack=inputs=2:shortest=0';
    if (slot.label) {
      const caption = path.join(out, `videos/${slot.id}.caption.txt`);
      await writeFile(caption, slot.label + '\n'); await record(`videos/${slot.id}.caption.txt`);
      composite += `,pad=1024:432:0:48:color=0x181818,drawtext=textfile=${caption.replace(/[:'\\]/g, '\\$&')}:expansion=none:fontcolor=white:fontsize=16:x=12:y=12`;
    }
    execFileSync('ffmpeg', ['-v', 'error', '-i', sources[0]!, '-i', sources[1]!, '-filter_complex', composite + '[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '20', '-threads', '2', output]);
  } else {
    const text = path.join(out, `videos/${slot.id}.missing.txt`);
    await writeFile(text, `MISSING: ${slot.id}\nNo complete predetermined comparison evidence\n${slot.why}\n`);
    await record(`videos/${slot.id}.missing.txt`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x181818:s=1024x384:r=10:d=3', '-vf', `drawtext=textfile=${text.replace(/[:'\\]/g, '\\$&')}:fontcolor=white:fontsize=20:x=30:y=140`, '-an', '-c:v', 'libx264', '-threads', '2', output]);
  }
  await record(relative);
  slotReceipts.push({ ...slot, sources, status: available ? 'present' : 'missing', file: relative, uncut: available, rendererPixelsExact: slot.id === '02-exact-replay' ? recordedReplay?.pixelIdentical ?? (exact?.proof as { pixelIdentical?: boolean } | undefined)?.pixelIdentical ?? null : null });
}
await json('videos/slots.json', { schema: 'simforge.training-release-video-slots/v1', slots: slotReceipts });
await json('provenance.json', { schema: 'simforge.training-release-provenance/v1', promotionDir, promotionSha256: createHash('sha256').update(reportBytes).digest('hex'), panelDigest: report.panel.digest, verdict: report.verdict, scope: report.scope, metrics: report.metricLabel, appearance: 'raw only unless explicitly labelled in source run; REGEN non-commercial research licence is not a product grant', createdAt: new Date().toISOString() });
await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify({ schema: 'simforge.training-release-manifest/v1', id: `training-poc-${id}`, videoSlots: slotReceipts.map(({ id, status, label }) => ({ id, status, label })), files: inventory }, null, 2)}\n`);
console.log(JSON.stringify({ out, files: inventory.length, videos: slotReceipts.map(({ id, status }) => ({ id, status })) }, null, 2));
