import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadMap } from '../../packages/compiler/src/node.js';
import { native } from '../../packages/native-runtime/src/index.js';
import { getProfile } from '../../packages/cli/src/commands/drive/profiles.js';
import { routeForActor } from '../../packages/cli/src/commands/drive/scene.js';
import { createTorchPolicy } from '../../packages/cli/src/commands/drive/policies/torch.js';
import { stripRgbaPadding } from '../../packages/render/src/native/service-client.js';

const configFile = process.argv[2];
if (!configFile) throw new Error('usage: student-rollouts.mts CONFIG.json');
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
const document = JSON.parse(await fs.readFile(config.episodes, 'utf8'));
const service = JSON.parse(await fs.readFile(config.renderer, 'utf8'));
const rig = getProfile('student-front');
const out = path.resolve(config.out);
await fs.mkdir(out, { recursive: true });
const receiptFile = path.join(out, 'collection.json');
const frameLimit = config.maxFrames ?? Number.POSITIVE_INFINITY;
const receipts: any[] = [];
const started = performance.now();
let decisions = 0, rendered = 0, retained = 0;
console.log('COLLECTOR_READY ' + out);
for (const index of config.indices as number[]) {
  if (retained >= frameLimit) break;
  const row = document.instances[index];
  const input = row.input;
  const map = await loadMap(input.mapId);
  const dir = path.join(out, `episode-${String(index).padStart(4, '0')}`);
  await fs.mkdir(path.join(dir, 'frames'), { recursive: true });
  const budgetHorizon = Number.isFinite(frameLimit) ? Math.min(Math.ceil(input.clipSeconds * 10) - 1, frameLimit - retained) : undefined;
  const episodeSpec = { scenario: input, seed: Number(input.seed), decisionHz: 10, mode: { kind: 'offline-simtime' }, warmupDecisions: 1, ...(budgetHorizon !== undefined ? { maxDecisions: budgetHorizon } : {}), observation: { channels: [{ kind: 'visible' }, { kind: 'cameras', rig: { cameras: rig }, passes: ['rgb'], backend: { kind: 'service', socket: service.socket } }] } };
  const episode = new (native().Episode)(JSON.stringify(episodeSpec), map.graph);
  const policy = await createTorchPolicy({ checkpoint: config.policy.replace(/^torch:/, ''), modelSocket: config.modelSocket, noStartModel: true });
  const steps: any[] = [];
  const egoHistory: number[][] = [];
  let health: unknown, totalReturn = 0, collision = false;
  const began = performance.now();
  const poseOf = (snapshot: any) => {
    const actor = snapshot.actors.find((actor: any) => actor.id === snapshot.egoId);
    if (!actor) throw new Error('snapshot missing ego');
    return { x: actor.state.x, y: actor.state.y, yawRad: actor.state.headingRad, speedMps: actor.state.speedMps, tS: snapshot.tS };
  };
  try {
    health = (await policy.start({ mapId: input.mapId, graph: map.graph, out: dir, log: (line) => console.log(line) })).hello;
    if ((health as any).protocol !== 'simforge.policy-endpoint/v3') throw new Error('collection requires endpoint v3');
    let obs = JSON.parse(episode.reset((payload: string, refs: any[]) => {
      try { const frame = JSON.parse(payload); const p = poseOf(frame.snapshot); egoHistory.push([p.x, p.y, p.yawRad, p.speedMps, p.tS]); rendered++; }
      finally { for (const ref of refs) ref.release(); }
    }));
    const egoSource = input.actors.find((actor: any) => actor.id === episode.ego);
    const authoredRoute = map.graph.route(JSON.stringify(egoSource.behavior.route));
    const initialPose = poseOf(JSON.parse(episode.snapshot()));
    const initialRemainingM = Math.max(0, authoredRoute.lengthM - Number(authoredRoute.projectPoint(initialPose.x, initialPose.y)[0]));
    let step = 0;
    while (!episode.ended) {
      const snapshot = JSON.parse(episode.snapshot());
      const pose = poseOf(snapshot);
      if (egoHistory.at(-1)?.[4] !== pose.tS) egoHistory.push([pose.x, pose.y, pose.yawRad, pose.speedMps, pose.tS]);
      if (egoHistory.length > 64) egoHistory.shift();
      const previous = egoHistory.at(-2);
      const dt = previous ? pose.tS - previous[4]! : 0;
      const yawRate = dt > 0 ? Math.atan2(Math.sin(pose.yawRad - previous![2]!), Math.cos(pose.yawRad - previous![2]!)) / dt : 0;
      const route = routeForActor(map.graph, egoSource, pose);
      const camera = obs.cameras[0];
      if (obs.cameras.length !== 1 || camera.width !== 640 || camera.height !== 360 || camera.pass !== 'rgb') throw new Error('wrong student camera contract');
      const ref = episode.frame(camera.frame.id);
      let rgb: Buffer;
      try {
        const rgba = stripRgbaPadding(ref.buffer(), camera.width, camera.height);
        rgb = await sharp(rgba, { raw: { width: 640, height: 360, channels: 4 } }).removeAlpha().raw().toBuffer();
      } finally { ref.release(); }
      const objects = (obs.objects ?? []).map((o: any) => [o.rangeM, o.bearingRad, o.rangeRateMps, o.lineOfSight ? 1 : 0, 1]);
      const observation = { state_vector: obs.stateVector, objects, pose, motion: [pose.speedMps, yawRate], route };
      const decision = await policy.act({ step, tS: pose.tS, pose, route, egoHistory, frames: { [camera.sensorId]: [rgb] }, frameSize: { width: 640, height: 360 }, egoId: episode.ego, actors: [], nativeObservation: { stateVector: obs.stateVector, objects }, mapId: input.mapId, graph: map.graph }, Number(input.seed) + step);
      if (decision.extras?.fallbackReason) throw new Error('closed-loop policy fallback');
      const a = decision.action;
      const action = a.control ? { k: 'c', c: [a.control.throttle, a.control.brake, a.control.steer] } : { k: 's', speedMps: a.targetSpeedMps, accelerationMps2: a.targetAccelerationMps2 };
      const result = JSON.parse(episode.step(JSON.stringify(action)));
      if (result.dl.miss || result.dl.ap !== 'policy') throw new Error('native fallback during collection');
      if (!result.appliedControl) throw new Error('native actuator label absent');
      decisions++; rendered++; totalReturn += result.reward;
      collision ||= result.termReason === 'collision';
      if (retained < frameLimit) {
        const frame = config.saveFrames === false ? null : `frames/${step}.png`;
        let frameSha256: string | null = null;
        if (frame) {
          const png = await sharp(rgb, { raw: { width: 640, height: 360, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
          await fs.writeFile(path.join(dir, frame), png);
          frameSha256 = createHash('sha256').update(png).digest('hex');
        }
        steps.push({ step, frame, frameSha256, observation, action, appliedControl: result.appliedControl, reward: result.reward, termReason: result.termReason, inferMs: decision.latencyMs });
        retained++;
      }
      obs = result.obs; step++;
    }
    const result = JSON.parse(episode.finish());
    const trace = episode.traceJson();
    await fs.writeFile(path.join(dir, 'trace.jsonl'), trace);
    await fs.writeFile(path.join(dir, 'steps.jsonl'), steps.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const finalPose = poseOf(JSON.parse(episode.snapshot()));
    const finalRemainingM = Math.max(0, authoredRoute.lengthM - Number(authoredRoute.projectPoint(finalPose.x, finalPose.y)[0]));
    const routeCompletion = initialRemainingM > 0 ? Math.min(1, Math.max(0, (initialRemainingM - finalRemainingM) / initialRemainingM)) : 1;
    const record = { schema: 'simforge.student-rollout/v1', index, source: config.episodes, provenance: row.provenance, input, episodeSpec, policy: config.policy, health, modelHealth: { protocol: 'simforge.policy-endpoint/v3', genuinePlans: step, closedLoopFallbacks: 0, invalidPlans: 0, timeouts: 0 }, retainedFrames: steps.length, decisions: step, renderedFrames: step + 2, totalReturn, collision, finalPose, initialRemainingM, finalRemainingM, routeCompletion, result, traceSha256: createHash('sha256').update(trace).digest('hex'), wallSeconds: (performance.now() - began) / 1000 };
    Object.assign(record, { collectionBudget: { nativePolicyDecisionCap: budgetHorizon ?? null, authoredPolicyDecisionCap: Math.ceil(input.clipSeconds * 10) - 1,
      budgetLimitedHorizon: budgetHorizon !== undefined && budgetHorizon < Math.ceil(input.clipSeconds * 10) - 1 && result.termReason === 'horizon' && step === budgetHorizon } });
    await fs.writeFile(path.join(dir, 'rollout.json'), JSON.stringify(record, null, 2) + '\n');
    receipts.push({ directory: dir, ...record, input: undefined, episodeSpec: undefined });
    console.log(`EPISODE_COMPLETE index=${index} frames=${steps.length} retained=${retained} decisions=${decisions}`);
  } finally { episode.close(); await policy.stop(); }
  await fs.writeFile(receiptFile, JSON.stringify({ schema: 'simforge.student-collection/v1', config, decisions, rendered, retained, wallSeconds: (performance.now() - started) / 1000, decisionsPerSecond: decisions / ((performance.now() - started) / 1000), episodes: receipts }, null, 2) + '\n');
}
if (Number.isFinite(frameLimit) && retained !== frameLimit) throw new Error(`collection exhausted at ${retained}/${frameLimit}`);
console.log(`COLLECTION_COMPLETE decisions=${decisions} rendered=${rendered} retained=${retained}`);
