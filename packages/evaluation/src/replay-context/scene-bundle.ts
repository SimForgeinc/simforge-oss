/**
 * Writing the renderer-facing scene bundle directory.
 *
 * The splat backend does not load a `simforge.replay-context/v1` document — it loads a scene
 * *directory* whose `background.json` names the source package, the `volume.nurec` member and
 * its digest, the episode window, the rig centroid and the actor-id-to-track mapping
 * (`renderer/splat/python/simforge_splat/backend.py::LoadedScene`). Until now that directory
 * had to come from somewhere else, which meant a package this module imported could not be
 * rendered, and therefore could not be gated on G1/G2.
 *
 * Everything the directory needs is already in the package, so this derives it rather than
 * asking a caller to supply it:
 *
 *   sourceUsdz / sourceUsdzSha256   from the bundle's pinned geometry
 *   digest + member                 streamed sha256 of `volume.nurec`
 *   episode.startTimestampUs        the reconstruction's own time support
 *   rigCentroid                     `rig_trajectories[0].rig_bbox.centroid`
 *   actorTracks                     `<actorId> -> <trackId>` for every imported track
 *
 * The one thing it does not invent is a map: lane context is bound explicitly or not at all.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CapabilityError } from './capability.js';
import { RawRigTrajectoriesSchema } from './importers/raw-schema.js';
import type { ReplayContext } from './schema.js';
import { hashZipMember, readZipIndex, readZipJson } from './usdz.js';

/** Actor id used in scene state for a recorded track, matching the importer's own convention. */
export function actorIdForTrack(trackId: string): string {
  return `nurec-${trackId}`;
}

export interface SceneBundleResult {
  readonly sceneDir: string;
  readonly mapId: string;
  readonly volumeDigest: string;
  readonly tracks: number;
}

/**
 * Write `<scenesRoot>/<sceneId>/background.json` for a package-imported bundle.
 *
 * `sceneId` becomes the directory name, which is the `mapId` the render job addresses the scene
 * by. Returns what a caller needs to drive `qualifyRenders` without re-deriving any of it.
 */
export async function writeSceneBundleDir(bundle: ReplayContext, scenesRoot: string): Promise<SceneBundleResult> {
  if (bundle.geometry.kind !== 'nurec-usdz') {
    throw new CapabilityError(`scene ${bundle.sceneId}: only a NuRec package can be written as a renderable scene bundle`);
  }
  const packagePath = path.resolve(bundle.geometry.sourcePackage);
  const entries = await readZipIndex(packagePath);
  const volume = entries.find((entry) => entry.name === 'volume.nurec');
  if (volume === undefined) {
    throw new CapabilityError(`${packagePath}: no volume.nurec member; this is not a renderable NuRec package`);
  }
  const rigRaw = await readZipJson(packagePath, entries, 'rig_trajectories.json');
  const rig = rigRaw === undefined ? undefined : RawRigTrajectoriesSchema.safeParse(rigRaw);
  const centroid = rig?.success === true ? (rig.data.rig_trajectories ?? [])[0]?.rig_bbox?.centroid : undefined;
  if (centroid === undefined || centroid.length < 2) {
    throw new CapabilityError(
      `${packagePath}: rig_trajectories[0].rig_bbox.centroid is absent; the rig cannot be placed without it`,
    );
  }

  // The digest pins the Gaussian volume itself, not just the archive around it, so a repacked
  // package with different geometry cannot pass as the one that was measured.
  const volumeDigest = await hashZipMember(packagePath, volume);

  const support = bundle.geometry.timeSupportUs ?? { startUs: bundle.ego.originUs, endUs: bundle.ego.endUs };
  const sceneDir = path.join(scenesRoot, bundle.sceneId);
  await mkdir(sceneDir, { recursive: true });

  const actorTracks: Record<string, string> = {};
  for (const track of bundle.dynamics.tracks) actorTracks[actorIdForTrack(track.trackId)] = track.trackId;

  const background = {
    schema: 'simforge.background-reference/v1',
    provider: 'nurec',
    sceneId: bundle.sceneId,
    sourceUsdz: packagePath,
    sourceUsdzSha256: bundle.geometry.sourcePackageSha256,
    member: 'volume.nurec',
    digest: volumeDigest,
    episode: {
      startTimestampUs: support.startUs,
      durationS: (support.endUs - support.startUs) / 1e6,
      timeBase: 'seconds-from-episode-start',
    },
    metadata: { timeRangeUs: { start: support.startUs, end: support.endUs } },
    rigCentroid: [centroid[0]!, centroid[1]!, centroid[2] ?? 0],
    cameraShutterDurationUs: bundle.cameras[0]?.timing.shutterUs ?? 30_000,
    actorTracks,
  };
  await writeFile(path.join(sceneDir, 'background.json'), `${JSON.stringify(background, null, 2)}\n`, 'utf8');

  return { sceneDir, mapId: bundle.sceneId, volumeDigest, tracks: bundle.dynamics.tracks.length };
}
