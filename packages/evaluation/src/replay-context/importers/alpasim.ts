/**
 * AlpaSim scene importer.
 *
 * AlpaSim publishes its public scene catalogue as two CSVs (`NVlabs/alpasim`,
 * `data/scenes/`):
 *
 *   `sim_scenes.csv`  uuid, scene_id, nre_version_string, path, last_modified,
 *                     artifact_repository, hf_revision
 *   `sim_suites.csv`  test_suite_id, scene_id, uuid
 *
 * The artifacts themselves are the same NuRec `.usdz` packages published in the
 * `nvidia/PhysicalAI-Autonomous-Vehicles-NuRec` dataset, pinned per row by `hf_revision`. So
 * this importer is a *resolver*, not a second format reader: it turns a suite/scene
 * selection into one exact artifact and hands it to the package importer. That is what makes
 * a SimForge run on an AlpaSim scene comparable to AlpaSim's own — same bytes, same
 * revision, recorded in provenance.
 *
 * Nothing is downloaded here. The dataset is gated and non-redistributable, so the artifact
 * must already be in the local AlpaSim scene cache; a cache miss is a refusal naming the
 * exact file and revision, not an implicit fetch of gigabytes onto a shared worker.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { RefusalError } from '../refusal.js';
import type { ReplayContext } from '../schema.js';
import type { GateThresholds } from '../gates.js';
import { importNurecPackage } from './package.js';

/** Default scene cache directory, as documented in AlpaSim's `data/scenes/README.md`. */
export const DEFAULT_SCENE_CACHE = 'data/nre-artifacts';

export interface AlpasimSceneRow {
  readonly uuid: string;
  readonly sceneId: string;
  readonly nreVersion: string;
  /** Path inside the Hugging Face dataset, also the layout used by the local cache. */
  readonly path: string;
  readonly artifactRepository: string;
  readonly hfRevision: string;
}

/**
 * Parse a catalogue CSV.
 *
 * Deliberately a plain split rather than a CSV library: these columns are uuids, ids,
 * versions and slash-separated paths, none of which are quoted or contain commas. A row that
 * does not match the declared header is skipped rather than silently mis-parsed into a
 * wrong artifact.
 */
function parseCsv(text: string): readonly Record<string, string>[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const header = lines[0]!.split(',').map((column) => column.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(',');
    if (cells.length !== header.length) continue;
    const row: Record<string, string> = {};
    header.forEach((column, index) => {
      row[column] = cells[index]!.trim();
    });
    rows.push(row);
  }
  return rows;
}

async function readCatalogue(scenesCsv: string): Promise<readonly AlpasimSceneRow[]> {
  let text: string;
  try {
    text = await readFile(scenesCsv, 'utf8');
  } catch (error) {
    throw new RefusalError({
      code: 'missing_fields',
      message: `AlpaSim scene catalogue ${scenesCsv} is not readable: ${(error as Error).message}`,
      missing: [{ path: scenesCsv, requirement: 'the sim_scenes.csv catalogue from an AlpaSim checkout' }],
      alternatives: [],
    });
  }
  return parseCsv(text)
    .filter((row) => row['uuid'] !== undefined && row['scene_id'] !== undefined && row['path'] !== undefined)
    .map((row) => ({
      uuid: row['uuid']!,
      sceneId: row['scene_id']!,
      nreVersion: row['nre_version_string'] ?? '',
      path: row['path']!,
      artifactRepository: row['artifact_repository'] ?? '',
      hfRevision: row['hf_revision'] ?? '',
    }));
}

export interface AlpasimResolveOptions {
  /** AlpaSim checkout root (the directory containing `data/scenes`). */
  readonly alpasimRoot: string;
  /** Select by readable scene id (`clipgt-<uuid>`) ... */
  readonly sceneId?: string;
  /** ... or by the exact artifact uuid, which is what a suite row pins. */
  readonly uuid?: string;
  /** Restrict the selection to one suite (`public_2601`, `public_2604`, ...). */
  readonly suite?: string;
}

/**
 * Resolve one exact artifact row.
 *
 * When several releases publish the same `scene_id`, an ambiguous selection is refused with
 * the candidate uuids rather than resolved by "most recent": which release a result came
 * from is a scientific fact about that result, not a convenience default.
 */
export async function resolveAlpasimScene(options: AlpasimResolveOptions): Promise<AlpasimSceneRow> {
  const scenesCsv = path.join(options.alpasimRoot, 'data', 'scenes', 'sim_scenes.csv');
  let rows = await readCatalogue(scenesCsv);

  if (options.suite !== undefined) {
    const suitesCsv = path.join(options.alpasimRoot, 'data', 'scenes', 'sim_suites.csv');
    const suiteText = await readFile(suitesCsv, 'utf8').catch(() => '');
    const allowed = new Set(
      parseCsv(suiteText)
        .filter((row) => row['test_suite_id'] === options.suite)
        .map((row) => row['uuid']!),
    );
    if (allowed.size === 0) {
      throw new RefusalError({
        code: 'unsupported_input',
        message: `AlpaSim suite "${options.suite}" is not present in ${suitesCsv}`,
        missing: [{ path: 'suite', requirement: 'a test_suite_id listed in sim_suites.csv' }],
        alternatives: [],
      });
    }
    rows = rows.filter((row) => allowed.has(row.uuid));
  }

  const matches = rows.filter(
    (row) => (options.uuid !== undefined && row.uuid === options.uuid)
      || (options.sceneId !== undefined && row.sceneId === options.sceneId),
  );
  if (matches.length === 0) {
    throw new RefusalError({
      code: 'unsupported_input',
      message: `no AlpaSim artifact matches ${options.uuid ?? options.sceneId ?? '<no selector>'}`,
      missing: [{ path: 'sceneId|uuid', requirement: 'a scene_id or uuid present in sim_scenes.csv' }],
      alternatives: [],
    });
  }
  if (matches.length > 1) {
    throw new RefusalError({
      code: 'unsupported_input',
      message:
        `scene ${options.sceneId ?? ''} is published by ${matches.length} artifacts `
        + `(${matches.map((row) => `${row.uuid}@${row.hfRevision}`).join(', ')}). `
        + 'Select one by uuid or restrict to a suite; SimForge does not pick a release for you.',
      missing: [{ path: 'uuid', requirement: 'the exact artifact uuid, or a suite that pins one' }],
      alternatives: [],
    });
  }
  return matches[0]!;
}

export interface AlpasimImportOptions extends AlpasimResolveOptions {
  /** Scene cache root; defaults to `<alpasimRoot>/data/nre-artifacts`. */
  readonly sceneCache?: string;
  readonly license: string;
  readonly thresholds?: GateThresholds;
}

/**
 * Resolve an AlpaSim scene and import its artifact into a replay-context bundle.
 *
 * The bundle records the suite, artifact uuid, NRE version and dataset revision in
 * `source.origin`, so a score produced on it can be traced back to the exact published scene
 * — which is the only basis on which our number and an AlpaSim number could ever be compared.
 */
export async function importAlpasimScene(options: AlpasimImportOptions): Promise<ReplayContext> {
  const row = await resolveAlpasimScene(options);
  const cacheRoot = options.sceneCache ?? path.join(options.alpasimRoot, DEFAULT_SCENE_CACHE);
  const artifact = path.join(cacheRoot, row.path);
  try {
    await stat(artifact);
  } catch {
    throw new RefusalError({
      code: 'missing_fields',
      message:
        `AlpaSim artifact ${row.uuid} (${row.sceneId}) is not in the local scene cache. `
        + 'The PhysicalAI-AV NuRec dataset is gated and non-redistributable, so SimForge will not fetch it implicitly.',
      missing: [
        {
          path: artifact,
          requirement:
            `download ${row.path} from the ${row.artifactRepository} dataset at revision ${row.hfRevision} `
            + 'with your own accepted dataset licence, into the scene cache',
        },
      ],
      alternatives: [],
    });
  }
  return importNurecPackage({
    packagePath: artifact,
    sceneId: row.sceneId,
    origin: `alpasim:${options.suite ?? 'catalogue'}/${row.uuid}@${row.hfRevision} (NRE ${row.nreVersion})`,
    license: options.license,
    redistributable: false,
    source: 'alpasim',
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });
}
