import { sha256BytesAsync, type StaticColliderClass, type StaticMapCollider } from '@simforge-oss/engine';

/**
 * Collider artifact schema per `variants['static-colliders'].schemaVersion`.
 * v1 carries 2D footprints (full-height prisms); v2 adds each collider's
 * vertical extent and drops overhead fixtures at ingest. Published v1
 * artifacts stay loadable with their v1 semantics.
 */
const SCHEMAS: Readonly<Record<number, string>> = {
  1: 'simforge.static-map-colliders/v1',
  2: 'simforge.static-map-colliders/v2',
};
const CLASSES = new Set<StaticColliderClass>(['building', 'wall', 'barrier', 'prop', 'road-boundary']);
/**
 * Same rule as `ROAD_BOUNDARY_MAX_THICKNESS_M` in the artifact builder
 * (`@simforge-oss/maps` ingest/static-colliders): a kerb or guardrail OBB is
 * only a strip. Artifacts published before the builder enforced it carry the
 * map-wide merged `Roads_Curb` mesh as a road-boundary slab the size of the
 * map, which every vehicle spawns inside. Published closures are immutable, so
 * the loader drops those here rather than waiting for every map to be
 * republished. The native bundle applies the same rule
 * (`simforge-compiler` bundle.rs `ROAD_BOUNDARY_MAX_THICKNESS_M`), so a host
 * that hands it unfiltered colliders still simulates the same map.
 */
const ROAD_BOUNDARY_MAX_THICKNESS_M = 2;

interface DerivativeManifest {
  readonly sourceManifestSha256?: string;
  readonly variants?: {
    readonly 'static-colliders'?: {
      readonly schemaVersion?: number;
      readonly file?: string;
      readonly digest?: string;
      readonly outputSha256?: string;
    };
  };
}

interface StaticColliderArtifact {
  readonly schema: string;
  readonly mapId: string;
  readonly sourceManifestSha256: string;
  readonly sources: readonly { readonly id: string; readonly file: string; readonly declaredBytes: number | null }[];
  readonly colliders: readonly StaticMapCollider[];
  readonly statistics: Omit<StaticColliderDiagnostics, 'digest' | 'status' | 'warning'>;
  readonly digest: string;
}

export interface StaticColliderDiagnostics {
  readonly digest: string;
  readonly status: 'ready' | 'unavailable' | 'skipped';
  readonly warning?: string;
  readonly sourceTiles: number;
  readonly accepted: number;
  readonly rejectedRoadOverlap: number;
  /** v2 artifacts: fixtures dropped at ingest because no body on the ground under them can reach them. */
  readonly rejectedOverhead?: number;
  readonly ignored: number;
  readonly classes: Readonly<Record<StaticColliderClass, number>>;
}

export interface StaticColliderBundle {
  readonly colliders: readonly StaticMapCollider[];
  readonly diagnostics: StaticColliderDiagnostics;
}

export function emptyStaticColliderBundle(
  status: 'unavailable' | 'skipped',
  warning: string,
): StaticColliderBundle {
  return {
    colliders: [],
    diagnostics: {
      digest: `static-colliders-v1-${status}`,
      status,
      warning,
      sourceTiles: 0,
      accepted: 0,
      rejectedRoadOverlap: 0,
      ignored: 0,
      classes: { building: 0, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
    },
  };
}

const cache = new Map<string, Promise<StaticColliderBundle>>();

/**
 * Load one precomputed collider artifact per map worker. Missing or malformed
 * derivatives resolve immediately to diagnostics; runtime GLB inspection is
 * deliberately not a fallback.
 */
export function loadStaticMapColliders(
  manifestUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<StaticColliderBundle> {
  const key = absoluteUrl(manifestUrl);
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = loadArtifact(key, fetcher).catch((error: unknown) => emptyStaticColliderBundle(
    'unavailable',
    error instanceof Error ? error.message : String(error),
  ));
  cache.set(key, pending);
  return pending;
}

async function loadArtifact(manifestUrl: string, fetcher: typeof fetch): Promise<StaticColliderBundle> {
  const derivativeUrl = new URL('variants/manifest.json', new URL('.', manifestUrl)).toString();
  const [sourceResponse, manifestResponse] = await Promise.all([fetcher(manifestUrl), fetcher(derivativeUrl)]);
  if (!sourceResponse.ok) throw new Error(`Map bundle manifest unavailable (${sourceResponse.status})`);
  if (!manifestResponse.ok) throw new Error(`Static collision derivative manifest unavailable (${manifestResponse.status})`);
  const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());
  const derivativeManifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifest = parseDerivativeManifest(derivativeManifestBytes);
  const variant = manifest.variants?.['static-colliders'];
  if (!variant || !SCHEMAS[variant.schemaVersion ?? 0] || typeof variant.file !== 'string') {
    throw new Error('Static collision derivative is not published for this map');
  }
  const artifactUrl = new URL(variant.file, new URL('.', derivativeUrl)).toString();
  const artifactResponse = await fetcher(artifactUrl);
  if (!artifactResponse.ok) throw new Error(`Static collision artifact unavailable (${artifactResponse.status})`);
  return verifyStaticColliderArtifact({
    sourceManifest: sourceBytes,
    derivativeManifest: derivativeManifestBytes,
    artifact: new Uint8Array(await artifactResponse.arrayBuffer()),
  });
}

/** The three published files a map's static colliders are verified from (`3d/manifest.json`, `3d/variants/manifest.json`, the artifact it names). */
export interface StaticColliderArtifactSources {
  readonly sourceManifest: Uint8Array;
  readonly derivativeManifest: Uint8Array;
  readonly artifact: Uint8Array;
}

function parseDerivativeManifest(bytes: Uint8Array): DerivativeManifest {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as DerivativeManifest;
  } catch {
    throw new Error('Static collision derivative manifest is not JSON');
  }
}

/**
 * Verify a map's published static-collider artifact and apply the
 * road-boundary rule. The ONE verification every simulation host uses: the
 * browser loader above fetches the three files and calls this; Node hosts
 * (workers, the compiler, the golden-trace corpus) read them from disk or S3
 * and call it too (`buildSimulationMapClosure`, `createSimulationMapBundle`).
 * Throws on any mismatch; a simulation must never silently run without the
 * map's colliders.
 */
export async function verifyStaticColliderArtifact(sources: StaticColliderArtifactSources): Promise<StaticColliderBundle> {
  const manifest = parseDerivativeManifest(sources.derivativeManifest);
  if (!isSha256(manifest.sourceManifestSha256) || await sha256BytesAsync(sources.sourceManifest) !== manifest.sourceManifestSha256) {
    throw new Error('Static collision derivative targets a stale map bundle');
  }
  const variant = manifest.variants?.['static-colliders'];
  const schemaVersion = variant?.schemaVersion ?? 0;
  if (!variant || !SCHEMAS[schemaVersion] || typeof variant.file !== 'string' || !isSha256(variant.outputSha256)) {
    throw new Error('Static collision derivative is not published for this map');
  }
  if (await sha256BytesAsync(sources.artifact) !== variant.outputSha256) throw new Error('Static collision artifact checksum mismatch');
  const artifact = JSON.parse(new TextDecoder().decode(sources.artifact)) as StaticColliderArtifact;
  validateArtifact(artifact, manifest, schemaVersion, variant.digest);
  const colliders = artifact.colliders.filter(
    (collider) => collider.class !== 'road-boundary' || Math.min(collider.obb.lengthM, collider.obb.widthM) <= ROAD_BOUNDARY_MAX_THICKNESS_M,
  );
  const dropped = artifact.colliders.length - colliders.length;
  return {
    colliders,
    diagnostics: {
      digest: artifact.digest,
      status: 'ready',
      ...artifact.statistics,
      accepted: colliders.length,
      ignored: artifact.statistics.ignored + dropped,
      classes: { ...artifact.statistics.classes, 'road-boundary': artifact.statistics.classes['road-boundary'] - dropped },
    },
  };
}

function validateArtifact(artifact: StaticColliderArtifact, manifest: DerivativeManifest, schemaVersion: number, expectedDigest?: string): void {
  if (!artifact || artifact.schema !== SCHEMAS[schemaVersion] || typeof artifact.mapId !== 'string') throw new Error('Static collision artifact has an unsupported schema');
  if (!isSha256(artifact.sourceManifestSha256) || artifact.sourceManifestSha256 !== manifest.sourceManifestSha256) {
    throw new Error('Static collision artifact targets a different map bundle');
  }
  if (!Array.isArray(artifact.sources) || !Array.isArray(artifact.colliders)) throw new Error('Static collision artifact has malformed collections');
  if (!artifact.statistics || artifact.statistics.accepted !== artifact.colliders.length || artifact.statistics.sourceTiles !== artifact.sources.length) {
    throw new Error('Static collision artifact statistics do not match its contents');
  }
  for (const value of [artifact.statistics.accepted, artifact.statistics.sourceTiles, artifact.statistics.rejectedRoadOverlap, artifact.statistics.ignored]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Static collision artifact statistics are malformed');
  }
  for (const name of CLASSES) {
    if (!Number.isSafeInteger(artifact.statistics.classes?.[name]) || artifact.statistics.classes[name] < 0) {
      throw new Error('Static collision artifact class statistics are malformed');
    }
  }
  let previousId = '';
  const seen = new Set<string>();
  for (const collider of artifact.colliders) {
    if (!collider || typeof collider.id !== 'string' || seen.has(collider.id) || collider.id.localeCompare(previousId) < 0) {
      throw new Error('Static collision artifact collider ids are invalid or non-deterministic');
    }
    seen.add(collider.id);
    previousId = collider.id;
    if (!CLASSES.has(collider.class) || !validObb(collider.obb)) throw new Error(`Static collision artifact has malformed collider ${collider.id}`);
    // v2 publishes every collider's vertical extent, v1 none: a mix would make
    // part of a map full-height prisms without saying so.
    if (schemaVersion === 2 ? !validVertical(collider.vertical) : collider.vertical !== undefined) {
      throw new Error(`Static collision artifact has malformed collider ${collider.id}: ${schemaVersion === 2 ? 'missing or invalid' : 'unexpected'} vertical extent`);
    }
  }
  if (!isSha256Digest(artifact.digest) || artifact.digest !== expectedDigest) throw new Error('Static collision artifact digest does not match its map bundle');
}

function validObb(obb: StaticMapCollider['obb'] | undefined): boolean {
  return Boolean(obb
    && Number.isFinite(obb.center?.x) && Number.isFinite(obb.center?.z)
    && Number.isFinite(obb.lengthM) && obb.lengthM > 0
    && Number.isFinite(obb.widthM) && obb.widthM > 0
    && Number.isFinite(obb.headingRad));
}

function validVertical(vertical: StaticMapCollider['vertical']): boolean {
  return Boolean(vertical && Number.isFinite(vertical.minY) && Number.isFinite(vertical.maxY) && vertical.minY <= vertical.maxY);
}

function absoluteUrl(url: string): string {
  return new URL(url, globalThis.location?.href ?? 'http://localhost/').toString();
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256-[a-f0-9]{64}$/.test(value);
}

/** Test-only reset; production retains fulfilled and failed map lookups. */
export function resetStaticColliderCacheForTests(): void {
  cache.clear();
}

/** Fail closed when a requested map has no verified static collision artifact. */
export function requireReadyStaticColliderBundle(bundle: StaticColliderBundle): StaticColliderBundle {
  if (bundle.diagnostics.status === 'ready') return bundle;
  const detail = bundle.diagnostics.warning?.trim();
  throw new Error(`Static map collision data is ${bundle.diagnostics.status}${detail ? `: ${detail}` : '.'}`);
}
