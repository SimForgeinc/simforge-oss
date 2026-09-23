import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap } from '../../packages/compiler/src/node.js';
import { actorModelCatalogs, nativeWorldPaths } from '../../packages/cli/src/commands/drive/scene.js';
import { resolveNativeLighting } from '../../packages/render/src/native/lighting.js';
import type { SimScenarioInput } from '../../packages/engine/src/index.js';

// Freeze the exact bench scene configuration; learning owns neither rendering nor dynamics.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [outArg, ...specs] = process.argv.slice(2);
if (!outArg || !specs.length) throw new Error('usage: student-scenes.mts OUT EPISODES.json...');
const out = path.resolve(outArg);
await fs.mkdir(out, { recursive: true });
const catalogs = await actorModelCatalogs(root);
const byMap = new Map<string, SimScenarioInput[]>();
for (const spec of specs) {
  const doc = JSON.parse(await fs.readFile(spec, 'utf8'));
  for (const row of doc.instances) {
    const input = row.input as SimScenarioInput;
    const bucket = byMap.get(input.mapId) ?? [];
    bucket.push(input); byMap.set(input.mapId, bucket);
  }
}
const scenes: Record<string, unknown> = {};
for (const [mapId, inputs] of byMap) {
  const map = await loadMap(mapId);
  const first = inputs[0]!;
  if (inputs.some((input) => JSON.stringify(input.operationalConditions) !== JSON.stringify(first.operationalConditions))) throw new Error(`${mapId}: mixed lighting needs separate scenes`);
  // Union complete authored routes, rather than a crop from the first demonstration.
  const actors = [...new Map(inputs.flatMap((input) => input.actors).map((actor) => [JSON.stringify(actor), actor])).values()];
  const workspace = path.join(out, mapId);
  await fs.mkdir(workspace, { recursive: true });
  const glbs = await nativeWorldPaths({ ...first, actors }, map.graph, root, workspace, async (line) => { console.log(line); });
  const conditions = first.operationalConditions;
  const look = resolveNativeLighting({ weather: conditions.weather === 'rain' ? 'light_rain' : conditions.weather, timeOfDay: conditions.timeOfDay === 'day' ? 'noon' : conditions.timeOfDay, surfacePatches: [] });
  const scene = { glbs, profile: 'cinematic', lighting: look.lighting, profileConfig: look.profileConfig, autoMeter: true, warmupFrames: 20, nearM: 0.5, farM: 900, vehicleModels: catalogs.vehicleModels.directory, pedestrianModels: catalogs.pedestrianModels.directory };
  const file = path.join(workspace, 'scene.json');
  const bytes = JSON.stringify(scene);
  await fs.writeFile(file, bytes);
  scenes[mapId] = { file, sha256: createHash('sha256').update(bytes).digest('hex'), glbs: glbs.length, graphDigest: map.graph.digest };
  console.log(`SCENE_READY ${mapId} glbs=${glbs.length}`);
}
await fs.writeFile(path.join(out, 'scenes.json'), JSON.stringify({ schema: 'simforge.student-scenes/v1', catalogs, scenes }, null, 2) + '\n');
