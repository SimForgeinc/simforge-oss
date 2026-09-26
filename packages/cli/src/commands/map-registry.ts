import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { composeNativeTextureClosure, runMapPipeline } from '@simforge-oss/map-pipeline';
import type { RegistryClosureArtifact } from '@simforge-oss/map-pipeline';
import {
  closureFromDirectory,
  createRegistryBackend,
  listMaps,
  loadDerivedClosure,
  promoteVersion,
  pruneVersions,
  publishVersion,
  pullVersion,
  pushSourceArchive,
  resolveVersion,
  combineRetentionSources,
  parseRetentionRefs,
  retentionSourceFromDocument,
  RETENTION_REFS_MAX_AGE_MS,
  type RetentionReferenceSource,
  type MapClosure,
  type DerivedClosureInput,
  type MapVersion,
  type RegistryBackend,
} from '@simforge-oss/map-registry';
import { basename, join, resolve } from 'node:path';
import { CliError, EXIT } from '../errors.js';
import { emit, emitLines } from '../output.js';
import { createAmbientTurnVerdictBuilder } from '@simforge-oss/compiler/node';

function defaultRegistryUrl(): string {
  return `file://${join(homedir(), 'simforge-assets', 'registry')}`;
}

export function registryUrl(explicit?: string): string {
  return explicit ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? process.env['SIMFORGE_MAPS_PUBLIC_URL'] ?? 'https://da3tufozhdsvl.cloudfront.net';
}

function writableBackend(url: string): RegistryBackend {
  return createRegistryBackend(url);
}

export interface RegistryListOptions {
  pretty: boolean;
  registry?: string;
}

export async function registryMapsList(options: RegistryListOptions): Promise<number> {
  const url = registryUrl(options.registry);
  const index = await listMaps(writableBackend(url));
  if (options.pretty) {
    const lines = [`registry: ${url}`, ''];
    for (const [name, entry] of Object.entries(index).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name}  ${entry.latest}  ${entry.summary['label'] ?? ''}`.trimEnd());
    }
    emitLines(lines);
  } else {
    emit({ registry: url, maps: index }, options);
  }
  return EXIT.ok;
}

export interface MapBuildOptions {
  directory: string;
  name: string;
  xodrPath?: string;
  sourcePath?: string;
  sourceManifest?: string;
  reuseMasterDir?: string;
  workDir: string;
  cellSize?: number;
  donorLibrary?: readonly string[];
  pretty: boolean;
}

/**
 * Build a map master and its web tier into `workDir` without publishing;
 * `maps ingest` publishes the same stages. Prints where the stage content
 * landed and the master/web reports.
 */
/**
 * Every scenario-ready map ships its ambient turn-verdict table in the web
 * closure (docs/engineering/engine-semver.md). SIMFORGE_MAP_AMBIENT_VERDICTS=skip
 * opts a build out explicitly.
 */
function ambientTurnVerdictOption(): { ambientTurnVerdicts?: ReturnType<typeof createAmbientTurnVerdictBuilder> } {
  return process.env['SIMFORGE_MAP_AMBIENT_VERDICTS'] === 'skip' ? {} : { ambientTurnVerdicts: createAmbientTurnVerdictBuilder() };
}

export async function registryMapsBuild(options: MapBuildOptions): Promise<number> {
  const started = Date.now();
  const pipeline = await runMapPipeline({
    sourceDir: resolve(options.directory),
    ...(options.xodrPath ? { xodrPath: resolve(options.xodrPath) } : {}),
    ...(options.sourcePath ? { sourcePath: resolve(options.sourcePath) } : {}),
    ...(options.sourceManifest ? { sourceManifest: resolve(options.sourceManifest) } : {}),
    ...(options.reuseMasterDir ? { reuseMasterDir: resolve(options.reuseMasterDir) } : {}),
    name: options.name,
    workDir: resolve(options.workDir),
    ...(options.cellSize ? { cellSize: options.cellSize } : {}),
    ...(options.donorLibrary ? { donorLibrary: options.donorLibrary } : {}),
    ...ambientTurnVerdictOption(),
  });
  emit({
    name: options.name,
    seconds: (Date.now() - started) / 1000,
    master: { contentDir: pipeline.stages.master.outputDir, closureDigest: pipeline.canonical.digest, report: pipeline.stages.master.report },
    web: pipeline.stages.web === undefined ? null : { contentDir: pipeline.stages.web.outputDir, closureDigest: pipeline.derived[0]!.digest, toolFingerprint: pipeline.stages.web.toolFingerprint, report: pipeline.stages.web.report },
  }, options);
  return EXIT.ok;
}

export interface RegistryIngestOptions {
  directory: string;
  name: string;
  xodrPath?: string;
  sourcePath?: string;
  sourceManifest?: string;
  reuseMasterDir?: string;
  workDir?: string;
  target?: 'private' | 'public';
  registry?: string;
  version?: MapVersion;
  label?: string;
  sourceRef?: string;
  /** Prebuilt web tier (`3d/**` + `images/*.ktx2`) to publish beside a prebuilt master. */
  webDirectory?: string;
  webFingerprint?: string;
  /** Web tier cell size in metres when the pipeline runs (default 100). */
  cellSize?: number;
  /** `master.gltf` files of already-built maps consulted as terrain-texture donors. */
  donorLibrary?: readonly string[];
  pretty: boolean;
}

function pipelineArtifactInput(artifact: RegistryClosureArtifact): DerivedClosureInput {
  const files = Object.fromEntries(
    Object.keys(artifact.closure.members).map((memberPath) => [
      memberPath,
      join(artifact.contentDir, ...memberPath.split('/')),
    ]),
  );
  return { closure: artifact.closure, files };
}

/**
 * Publish a map. `directory` is either a prebuilt master (has `master.gltf`;
 * published as-is, with `--web-dir` for its tier) or a source export
 * directory (one RoadRunner/Unreal GLB plus its .xodr) that the pipeline
 * turns into a master and a web tier first.
 */
export async function registryMapsIngest(options: RegistryIngestOptions): Promise<number> {
  const directory = resolve(options.directory);
  let prebuilt = true;
  try {
    await access(join(directory, 'master.gltf'));
  } catch {
    prebuilt = false;
  }

  let canonical: DerivedClosureInput;
  let derived: DerivedClosureInput[];
  if (prebuilt) {
    canonical = await closureFromDirectory(directory);
    if (options.webDirectory === undefined) throw new Error('publishing a map master requires --web-dir');
    let fingerprint = options.webFingerprint;
    if (!fingerprint) {
      // Use the actual completed build descriptor, not an invented basename fingerprint.
      const webClosure = JSON.parse(await readFile(join(resolve(options.webDirectory), '..', 'closure.json'), 'utf8')) as MapClosure;
      if (webClosure.kind !== 'web' || !webClosure.toolFingerprint) throw new Error('prebuilt web tier has no recorded tool fingerprint');
      fingerprint = webClosure.toolFingerprint;
    }
    derived = [await closureFromDirectory(resolve(options.webDirectory), 'web', fingerprint)];
    canonical = await composeNativeTextureClosure(canonical, derived[0]!);
  } else {
    const workDir = options.workDir ?? process.env['SIMFORGE_MAP_WORK_DIR'];
    if (!workDir) throw new Error('source ingestion requires --work-dir or SIMFORGE_MAP_WORK_DIR for durable resumable builds');
    const pipeline = await runMapPipeline({
      sourceDir: directory,
      ...(options.xodrPath ? { xodrPath: resolve(options.xodrPath) } : {}),
      ...(options.sourcePath ? { sourcePath: resolve(options.sourcePath) } : {}),
      ...(options.sourceManifest ? { sourceManifest: resolve(options.sourceManifest) } : {}),
      ...(options.reuseMasterDir ? { reuseMasterDir: resolve(options.reuseMasterDir) } : {}),
      name: options.name,
      workDir: resolve(workDir),
      ...(options.cellSize ? { cellSize: options.cellSize } : {}),
      ...(options.donorLibrary ? { donorLibrary: options.donorLibrary } : {}),
      ...ambientTurnVerdictOption(),
    });
    canonical = pipelineArtifactInput(pipeline.canonical);
    derived = pipeline.derived.map(pipelineArtifactInput);
  }
  const url = options.registry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const published = await publishVersion(writableBackend(url), {
    name: options.name,
    version: options.version,
    closure: canonical.closure,
    files: canonical.files,
    derived,
    target: options.target ?? 'private',
    summary: options.label === undefined ? {} : { label: options.label },
    sourceRef: options.sourceRef,
  });
  emit({ registry: url, ...published }, options);
  return EXIT.ok;
}

export interface RegistryPullOptions {
  reference: string;
  registry?: string;
  cacheRoot?: string;
  browserRoot?: string;
  devAssetsRoot?: string;
  nativeCorpusRoot?: string;
  blobCacheRoot?: string;
  /** Require the immutable release's published web tier to have this tool fingerprint. */
  webFingerprint?: string;
  /** Also materialize the verbatim source rasters under dev-assets. */
  archive?: boolean;
  pretty: boolean;
}

/**
 * Pull a map version into the local layouts: `.corpus/<map>` for the native
 * renderer (master + KTX2 + sidecars), `map-bundles/<map>` for the viewer
 * (web tier + KTX2) and `dev-assets/<map>` for the sidecars alone.
 */
export async function registryMapsPull(options: RegistryPullOptions): Promise<number> {
  const url = registryUrl(options.registry);
  const backend = writableBackend(url);
  let derived: MapClosure[] | undefined;
  if (options.webFingerprint !== undefined) {
    const resolved = await resolveVersion(backend, options.reference);
    derived = [await loadDerivedClosure(backend, resolved.name, resolved.record.version, 'web', options.webFingerprint)];
  }
  const cacheRoot = resolve(options.cacheRoot ?? process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'simforge', 'maps'));
  const result = await pullVersion(backend, options.reference, {
    layouts: {
      browserBundlesRoot: resolve(options.browserRoot ?? join(cacheRoot, 'map-bundles')),
      devAssetsRoot: resolve(options.devAssetsRoot ?? join(cacheRoot, 'dev-assets')),
      nativeCorpusRoot: resolve(options.nativeCorpusRoot ?? join(cacheRoot, '.corpus')),
      blobCacheRoot: resolve(options.blobCacheRoot ?? join(cacheRoot, '.blobs')),
    },
    ...(derived === undefined ? {} : { derivedClosures: derived }),
    ...(options.archive === true ? { archive: true } : {}),
  });
  emit({ registry: url, ...result }, options);
  return EXIT.ok;
}

export interface RegistryPromoteOptions {
  reference: string;
  sourceRegistry?: string;
  destinationRegistry?: string;
  target?: 'private' | 'public';
  pretty: boolean;
}

export async function registryMapsPromote(options: RegistryPromoteOptions): Promise<number> {
  const sourceUrl = options.sourceRegistry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const destinationUrl = options.destinationRegistry ?? process.env['SIMFORGE_MAPS_PUBLIC_URL'];
  if (destinationUrl === undefined) throw new Error('promotion needs --destination-registry or SIMFORGE_MAPS_PUBLIC_URL');
  const result = await promoteVersion(writableBackend(sourceUrl), writableBackend(destinationUrl), {
    reference: options.reference,
    sourceRegistry: sourceUrl,
    target: options.target ?? 'public',
  });
  emit({ sourceRegistry: sourceUrl, destinationRegistry: destinationUrl, ...result }, options);
  return EXIT.ok;
}

export interface RegistryPruneOptions {
  /** `name` or `name@vN`. */
  reference: string;
  registry?: string;
  keepLatest?: boolean;
  wholeMap?: boolean;
  gc?: boolean;
  /**
   * `simforge.retention-refs.v1` documents (file paths or http(s) URLs) naming
   * every digest the owning installation's revisions, simulation results and
   * render jobs still reference. Required with `gc`.
   */
  refs?: readonly string[];
  /** Reject refs snapshots older than this many minutes (default 60). */
  refsMaxAgeMinutes?: number;
  apply?: boolean;
  pretty: boolean;
}

/**
 * Load and validate retention refs documents. Every location must load and
 * validate; one bad location fails the whole prune rather than shrinking the
 * protected set.
 */
export async function loadRetentionRefs(
  locations: readonly string[],
  options: { maxAgeMs?: number; fetchImpl?: typeof fetch; now?: () => number; token?: string } = {},
): Promise<RetentionReferenceSource> {
  const sources: RetentionReferenceSource[] = [];
  for (const location of locations) {
    let text: string;
    if (/^https?:\/\//.test(location)) {
      const token = options.token ?? process.env['SIMFORGE_RETENTION_REFS_TOKEN'];
      const response = await (options.fetchImpl ?? fetch)(location, {
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!response.ok) {
        throw new CliError('retention_refs_unavailable', `retention refs ${location} answered HTTP ${response.status}; nothing was deleted`, { path: '--refs' });
      }
      text = await response.text();
    } else {
      try {
        text = await readFile(location.startsWith('file://') ? new URL(location) : location, 'utf8');
      } catch (error) {
        throw new CliError('retention_refs_unavailable', `cannot read retention refs ${location}: ${(error as Error).message}`, { path: '--refs' });
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliError('bad_value', `retention refs ${location} is not JSON`, { path: '--refs' });
    }
    try {
      sources.push(retentionSourceFromDocument(parseRetentionRefs(parsed, location), location, {
        ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }));
    } catch (error) {
      throw new CliError('bad_value', (error as Error).message, { path: '--refs' });
    }
  }
  return combineRetentionSources(sources);
}

/**
 * Remove immutable releases from a registry. Defaults to a dry run so the
 * object and blob counts can be reviewed before anything is deleted.
 */
export async function registryMapsPrune(options: RegistryPruneOptions): Promise<number> {
  const url = options.registry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const separator = options.reference.lastIndexOf('@');
  const name = separator === -1 ? options.reference : options.reference.slice(0, separator);
  const version = separator === -1 ? undefined : options.reference.slice(separator + 1);
  if (version !== undefined && !/^v[1-9][0-9]*$/.test(version)) {
    throw new CliError('bad_value', `invalid map version: ${version}`, { path: 'name[@version]' });
  }
  if (version === undefined && options.keepLatest !== true && options.wholeMap !== true) {
    throw new CliError('bad_value', 'prune needs name@vN, --keep-latest or --whole-map', { path: 'name[@version]' });
  }
  if (options.gc === true && (options.refs?.length ?? 0) === 0) {
    throw new CliError(
      'retention_refs_required',
      'maps prune --gc deletes content-addressed blobs, and the registry cannot see what scenario revisions, saved ' +
      'simulation results or render jobs still reference. Refusing to run without --refs <file|https-url>: a ' +
      'simforge.retention-refs.v1 document generated by the installation that owns those records right before ' +
      'pruning (for a Studio database: `pnpm --filter @simforge-oss/studio retention:refs -- --out refs.json`). Nothing was deleted.',
      { path: '--refs' },
    );
  }
  const retentionRefs = (options.refs?.length ?? 0) > 0
    ? await loadRetentionRefs(options.refs!, {
      maxAgeMs: options.refsMaxAgeMinutes === undefined ? RETENTION_REFS_MAX_AGE_MS : options.refsMaxAgeMinutes * 60_000,
    })
    : undefined;
  const result = await pruneVersions(writableBackend(url), {
    name,
    ...(retentionRefs === undefined ? {} : { retentionRefs }),
    ...(version === undefined ? {} : { versions: [version as `v${number}`] }),
    ...(options.keepLatest === true ? { keepLatest: true } : {}),
    ...(options.wholeMap === true ? { wholeMap: true } : {}),
    ...(options.gc === true ? { collectGarbage: true } : {}),
    dryRun: options.apply !== true,
  });
  emit({
    registry: url,
    applied: options.apply === true,
    name: result.name,
    removedVersions: result.removedVersions,
    retainedVersions: result.retainedVersions,
    removedObjectCount: result.removedObjects.length,
    removedBlobCount: result.removedBlobs.length,
    retainedBlobCount: result.retainedBlobs.length,
    ...(result.retentionSource === undefined ? {} : { retentionSource: result.retentionSource }),
  }, options);
  return EXIT.ok;
}

function internalRegistryUrl(): string {
  const bucket = process.env['SIMFORGE_MAPS_INTERNAL_BUCKET'];
  if (bucket === undefined) return defaultRegistryUrl();
  return bucket.startsWith('s3://') ? bucket : `s3://${bucket}`;
}

export interface RegistrySourcePushOptions {
  archivePath: string;
  name: string;
  label?: string;
  date?: string;
  resumeFile?: string;
  registry?: string;
  pretty: boolean;
}

export async function registryMapsSourcePush(options: RegistrySourcePushOptions): Promise<number> {
  const url = options.registry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const archiveName = basename(options.archivePath).replace(/\.[^.]+$/, '');
  const label = options.label ?? archiveName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const key = await pushSourceArchive(writableBackend(url), {
    name: options.name,
    archivePath: resolve(options.archivePath),
    label,
    date: options.date,
    resumeFile: options.resumeFile,
  });
  emit({ registry: url, key }, options);
  return EXIT.ok;
}
