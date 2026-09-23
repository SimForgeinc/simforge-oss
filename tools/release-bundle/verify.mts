import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareNativeEpisodeTraces } from '../../packages/evaluation/src/campaign.js';

const root = process.argv[2] ? path.resolve(process.argv[2]) : null;
const complete = process.argv.includes('--require-complete');
if (!root || process.argv.slice(3).some((arg) => arg !== '--require-complete')) throw new Error('usage: verify.mts BUNDLE [--require-complete]');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.schema !== 'simforge.training-release-manifest/v1' || !Array.isArray(manifest.files)) throw new Error('invalid release inventory');
const seen = new Set<string>();
let bytes = 0;
for (const item of manifest.files) {
  if (typeof item.path !== 'string' || path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..') || seen.has(item.path)) throw new Error('unsafe or duplicate inventory path');
  seen.add(item.path);
  const file = path.join(root, item.path);
  const buffer = await readFile(file);
  if (!(await stat(file)).isFile() || buffer.length !== item.bytes || createHash('sha256').update(buffer).digest('hex') !== item.sha256) throw new Error(`inventory mismatch: ${item.path}`);
  bytes += buffer.length;
}
for (const file of ['promotion.json', 'provenance.json', 'videos/slots.json', 'checkpoints/refs.json']) if (!seen.has(file)) throw new Error(`inventory omits ${file}`);
const provenance = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));
const promotion = await readFile(path.join(root, 'promotion.json'));
if (createHash('sha256').update(promotion).digest('hex') !== provenance.promotionSha256) throw new Error('promotion provenance mismatch');
const slots = JSON.parse(await readFile(path.join(root, 'videos/slots.json'), 'utf8'));
if (slots.schema !== 'simforge.training-release-video-slots/v1' || slots.slots.length !== 6) throw new Error('release requires exactly six predetermined video slots');
const expected = ['01-worst-failure', '02-exact-replay', '03-held-out-map', '04-teacher-versus-student', '05-bc-versus-dagger', '06-training-timelapse'];
if (new Set(slots.slots.map((slot: any) => slot.id)).size !== 6 || (complete && JSON.stringify(slots.slots.map((slot: any) => slot.id)) !== JSON.stringify(expected))) throw new Error('video slot identities differ from the fixed student release contract');
const replayLabel = 'recorded-action replay (renderer RGB nondeterministic; not a model re-inference)';
let replayProof = null;
const replaySlot = slots.slots.find((slot: any) => slot.label === replayLabel);
if (replaySlot) {
  for (const file of ['replay/replay.json', 'replay/trace.jsonl', 'manifests/runs.json', 'videos/02-exact-replay.caption.txt']) if (!seen.has(file)) throw new Error('recorded replay omitted its disclosed source proof');
  if (manifest.videoSlots?.find((slot: any) => slot.id === replaySlot.id)?.label !== replayLabel || (await readFile(path.join(root, 'videos/02-exact-replay.caption.txt'), 'utf8')).trim() !== replayLabel) throw new Error('recorded replay disclosure differs between card and manifest');
  const replay = JSON.parse(await readFile(path.join(root, 'replay/replay.json'), 'utf8'));
  if (replay.label !== replayLabel || replay.isModelReInference !== false || replay.promotable !== false) throw new Error('recorded replay cannot claim model re-inference or promotion');
  const runs = JSON.parse(await readFile(path.join(root, 'manifests/runs.json'), 'utf8')).runs;
  const original = runs.find((run: any) => run.source === replay.sourceRun);
  if (!original) throw new Error('original native trace is not bundled');
  const originalTrace = await readFile(path.join(root, original.bundle, 'trace.jsonl'), 'utf8');
  const replayTrace = await readFile(path.join(root, 'replay/trace.jsonl'), 'utf8');
  replayProof = compareNativeEpisodeTraces(originalTrace, replayTrace);
  if (!replayProof.match || replayProof.original.stateDigest !== replay.worldActionChainDigest || createHash('sha256').update(originalTrace).digest('hex') !== replay.sourceTraceSha256 || createHash('sha256').update(replayTrace).digest('hex') !== replay.replayTraceSha256) throw new Error('recorded replay world/action/native-chain proof failed');
}
const videos = [];
for (const slot of slots.slots) {
  if (!seen.has(slot.file) || (complete && slot.status !== 'present')) throw new Error(`missing release slot ${slot.id}`);
  const file = path.join(root, slot.file);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,nb_frames,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' }));
  if (!(Number(probe.format.duration) > 0) || !probe.streams.some((stream: any) => stream.codec_name === 'h264' && stream.width > 0 && stream.height > 0)) throw new Error(`invalid H.264 video ${slot.id}`);
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
  videos.push({ id: slot.id, status: slot.status, durationS: Number(probe.format.duration), streams: probe.streams });
}
console.log(JSON.stringify({ schema: 'simforge.training-release-verification/v1', passed: true, bundle: root, files: seen.size, bytes, allVideoSlotsPresent: slots.slots.every((slot: any) => slot.status === 'present'), recordedReplayProof: replayProof, videos }, null, 2));
