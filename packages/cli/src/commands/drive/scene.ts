import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LaneGraph, SimScenarioInput } from '@simforge-oss/engine';

export type Route = { readonly points: number[][]; readonly remainingM: number };

export async function nativeWorldPaths(input: SimScenarioInput, graph: LaneGraph, root: string, workspace: string, log: (message: string) => Promise<void>, explicit?: string): Promise<string[]> {
  const override = explicit ?? process.env['SIMFORGE_NATIVE_WORLD'];
  if (override) {
    const entry = await fs.stat(override);
    if (entry.isFile()) return [path.resolve(override)];
    const files = readdirSync(override).filter((name) => /\.(glb|gltf)$/.test(name)).sort();
    if (files.length === 0) throw new Error(`no prepared native meshes in ${override}`);
    return files.map((file) => path.resolve(override, file));
  }
  const cache = process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'simforge', 'maps');
  // Reuse the proven BC7 selector: it verifies tier digests, decodes meshopt
  // and dequantizes the selected GLBs. Raw bundle tiles are not Bevy inputs.
  const points = input.actors.flatMap((actor) => {
    const pose = actor.initial.pose;
    return [[pose.x, 0, pose.z], ...routeForActor(graph, actor, { x: pose.x, y: -pose.z }).points.map(([x, y]) => [x!, 0, -y!])];
  });
  const routePath = path.join(workspace, 'tile-route.json');
  const prepared = path.join(cache, '.corpus', input.mapId, 'drive-bc7');
  await fs.writeFile(routePath, JSON.stringify({ mapId: input.mapId, frames: [{ actors: points.map((position) => ({ position })) }] }));
  const selector = spawn('python3', [
    path.join(root, 'adapters/jev-driver/select_tiles.py'),
    '--scene-state', routePath, '--maps-root', path.join(cache, 'map-bundles'),
    '--out', prepared, '--texture-tier', 'textures-512-bc7', '--radius-m', '140',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  selector.stdout?.on('data', (chunk) => { output += String(chunk); });
  selector.stderr?.on('data', (chunk) => { output += String(chunk); });
  const [code] = await once(selector, 'close');
  await log(`native tile preparation: ${output.trim()}`);
  if (code !== 0) throw new Error(`native BC7 tile preparation failed (${code}): ${output}`);
  const selection = JSON.parse(await fs.readFile(path.join(prepared, 'selection.json'), 'utf8')) as { glbs: string[] };
  return selection.glbs;
}

export interface ActorModelCatalog {
  readonly directory: string;
  /** SHA-256 of `catalog-models.json`, the assignment sidecar the service loads. */
  readonly catalogSha256: string;
  readonly entries: number;
}

export interface ActorModelCatalogs {
  readonly vehicleModels: ActorModelCatalog;
  readonly pedestrianModels: ActorModelCatalog;
}

/**
 * CarlaVehicles/CarlaWalkers catalog pack roots the render service loads actor
 * GLBs from. Without them every vehicle and pedestrian stays a procedural
 * cuboid proxy, so the bench always passes the repository catalogs;
 * `--vehicle-models`/`--pedestrian-models` (or the matching
 * `SIMFORGE_VEHICLE_MODELS`/`SIMFORGE_PEDESTRIAN_MODELS`) name an installed
 * copy. A configured pack without its `catalog-models.json` sidecar is an
 * error rather than a silent downgrade to proxies.
 */
export async function actorModelCatalogs(root: string, overrides: { vehicleModels?: string; pedestrianModels?: string } = {}): Promise<ActorModelCatalogs> {
  const resolve = async (explicit: string | undefined, variable: string, fallback: string): Promise<ActorModelCatalog> => {
    const configured = (explicit ?? process.env[variable])?.trim();
    const directory = path.resolve(configured && configured.length > 0 ? configured : path.join(root, fallback));
    const sidecar = path.join(directory, 'catalog-models.json');
    const bytes = await fs.readFile(sidecar).catch(() => null);
    if (!bytes) throw new Error(`actor model catalog ${directory} has no catalog-models.json (set ${variable} to a vehicles-carla style pack root)`);
    const document = JSON.parse(bytes.toString('utf8')) as { entries?: Record<string, unknown> };
    return {
      directory,
      catalogSha256: createHash('sha256').update(bytes).digest('hex'),
      entries: Object.keys(document.entries ?? {}).length,
    };
  };
  return {
    vehicleModels: await resolve(overrides.vehicleModels, 'SIMFORGE_VEHICLE_MODELS', 'catalog/vehicles-carla'),
    pedestrianModels: await resolve(overrides.pedestrianModels, 'SIMFORGE_PEDESTRIAN_MODELS', 'catalog/pedestrians-carla'),
  };
}

/** Up to 120 m of the actor's authored route ahead of `pose`, sampled every 2 m. */
function authoredRouteAhead(graph: LaneGraph, actor: SimScenarioInput['actors'][number], pose: { x: number; y: number }): Route | null {
  let route: ReturnType<LaneGraph['route']>;
  try {
    route = graph.route(JSON.stringify(actor.behavior.route));
  } catch {
    return null;
  }
  const current = Math.max(0, Number(route.projectPoint(pose.x, pose.y)[0] ?? 0));
  const end = Math.min(route.lengthM, current + 120);
  const points: number[][] = [];
  for (let distance = current; distance <= end + 1e-6; distance += 2) {
    const sample = route.poseAt(distance);
    points.push([Number(sample[0] ?? pose.x), Number(sample[1] ?? pose.y)]);
  }
  return points.length >= 2 ? { points, remainingM: Math.max(0, route.lengthM - current) } : null;
}

/**
 * World-frame route ahead of `pose`: the authored route while it has road
 * left, otherwise the nearest lane so every policy always sees a direction.
 */
export function routeForActor(graph: LaneGraph, actor: SimScenarioInput['actors'][number], pose: { x: number; y: number }): Route {
  const authored = authoredRouteAhead(graph, actor, pose);
  if (authored) return authored;
  const nearest = graph.nearestLane(pose.x, pose.y, 50);
  if (!nearest) return { points: [[pose.x, pose.y], [pose.x, pose.y]], remainingM: 0 };
  const [rsl, storageS] = nearest;
  const points: number[][] = [];
  for (let distance = 0; distance <= 120; distance += 2) {
    const sample = graph.sampleLane(rsl, storageS + distance, false);
    points.push([Number(sample[0] ?? pose.x), Number(sample[1] ?? pose.y)]);
  }
  return { points, remainingM: Math.max(0, graph.laneLengthM(rsl) - storageS) };
}
