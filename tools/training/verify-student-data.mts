import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { verifyEpisodeTrace } from '../../packages/evaluation/src/scoring.js';

const [out, ...collections] = process.argv.slice(2);
if (!out || !collections.length) throw new Error('usage: verify-student-data.mts OUTPUT.json COLLECTION.json...');
let frames = 0, decisions = 0, renderedFrames = 0;
const runs = [];
for (const collection of collections) {
  const document = JSON.parse(await readFile(collection, 'utf8'));
  let retained = 0;
  for (const item of document.episodes) {
    const directory = item.directory;
    const rollout = JSON.parse(await readFile(path.join(directory, 'rollout.json'), 'utf8'));
    const traceBytes = await readFile(path.join(directory, 'trace.jsonl'));
    if (createHash('sha256').update(traceBytes).digest('hex') !== rollout.traceSha256) throw new Error('native trace artifact changed');
    const trace = traceBytes.toString().trim().split('\n').map((line) => JSON.parse(line));
    const chain = verifyEpisodeTrace(trace);
    if (chain !== rollout.result.episodeDigest || rollout.result.status !== 'succeeded' || rollout.result.decisions !== rollout.decisions || rollout.result.deadlineMisses !== 0 || rollout.health.protocol !== 'simforge.policy-endpoint/v3') throw new Error(`${directory}: incomplete or unhealthy native episode`);
    const steps = (await readFile(path.join(directory, 'steps.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    if (steps.length !== rollout.retainedFrames || steps.length > rollout.decisions) throw new Error('retained decision count differs');
    for (const [index, row] of steps.entries()) {
      if (row.step !== index) throw new Error('noncontiguous retained sequence');
      if (!row.frame) continue; // Native validation deliberately stores no PNGs.
      const file = path.join(directory, row.frame);
      const png = await readFile(file);
      if (createHash('sha256').update(png).digest('hex') !== row.frameSha256) throw new Error(`${file}: PNG identity differs`);
      const before = trace[index + rollout.episodeSpec.warmupDecisions];
      const bundle = before.cameras ?? before.reset?.observation?.cameras;
      const camera = bundle?.frames.find((frame: any) => frame.sensorId === 'camera_student_front' && frame.pass === 'rgb');
      if (!camera || camera.width !== 640 || camera.height !== 360 || camera.rowStride !== 640 * 4 || camera.format !== 'rgba8') throw new Error('student native camera contract differs');
      const rgba = await sharp(png).ensureAlpha().raw().toBuffer();
      if (createHash('sha256').update(rgba).digest('hex') !== camera.sha256) throw new Error(`${file}: decoded student observation differs from native pre-action pixels`);
      frames++;
    }
    retained += steps.length; decisions += rollout.decisions; renderedFrames += rollout.renderedFrames;
    runs.push({ directory, decisions: rollout.decisions, retained: steps.length, traceDigest: chain, status: rollout.result.status });
  }
  if (retained !== document.retained) throw new Error(`${collection}: total retained accounting differs`);
}
const receipt = { schema: 'simforge.student-data-verification/v1', passed: true, frames, decisions, renderedFrames, nativeChains: runs.length, nativePreActionPixelsVerified: frames, runs };
await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, runs: undefined }));
