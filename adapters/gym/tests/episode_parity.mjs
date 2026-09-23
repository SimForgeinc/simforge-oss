// The N-API half of test_episode_parity.py: real native stepping, no JS loop logic.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [addon, inputPath, out] = process.argv.slice(2);
const native = createRequire(import.meta.url)(addon);
const { spec, topology, actions } = JSON.parse(readFileSync(inputPath, 'utf8'));
const graph = native.LaneGraph.fromTopology(Buffer.from(JSON.stringify(topology)));
const episode = new native.Episode(JSON.stringify(spec), graph);
const cameraEvidence = [];
const consume = (obs) => {
  if (!obs.cameras) return;
  const frames = obs.cameras.map((camera) => {
    const ref = episode.frame(camera.frame.id);
    try {
      const bytes = ref.buffer();
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== camera.frame.sha256) throw new Error(`camera payload digest mismatch ${camera.sensorId}`);
      if (cameraEvidence.length === 0) writeFileSync(join(out, `napi.${camera.sensorId}.${camera.pass}.raw`), bytes);
      return { sensorId: camera.sensorId, pass: camera.pass, width: camera.width, height: camera.height,
        rowStride: camera.frame.rowStride, digest: camera.frame.digest, sha256: digest };
    } finally { ref.release(); }
  });
  cameraEvidence.push({ tS: obs.tS, scene: JSON.parse(episode.sceneStateJson()), frames });
};
const reset = JSON.parse(episode.reset());
consume(reset);
const results = actions.map((action) => {
  const result = JSON.parse(episode.step(JSON.stringify(action)));
  consume(result.obs);
  return result;
});
const core = JSON.parse(episode.finish());
writeFileSync(join(out, 'napi.trace.jsonl'), episode.traceJson());
writeFileSync(join(out, 'napi.result.json'), JSON.stringify({ reset, results, core, digest: episode.traceDigest() }));
console.log(JSON.stringify({ binding: 'napi', decisions: core.decisions, simulationS: core.timing.simulationS, digest: episode.traceDigest() }));
if (cameraEvidence.length) writeFileSync(join(out, 'napi.cameras.json'), JSON.stringify(cameraEvidence));
episode.close();
