import { sha256Bytes, type StaticColliderClass, type StaticMapCollider } from '@simforge-oss/engine';

const SCHEMA = 'simforge.static-map-colliders/v1';
const CLASSES = new Set<StaticColliderClass>(['building', 'wall', 'barrier', 'prop', 'road-boundary']);
/**
 * Same rule as `ROAD_BOUNDARY_MAX_THICKNESS_M` in the artifact builder
 * (`@simforge-oss/maps` ingest/static-colliders): a kerb or guardrail OBB is
 * only a strip. Artifacts published before the builder enforced it carry the
 * map-wide merged `Roads_Curb` mesh as a road-boundary slab the size of the
 * map, which every vehicle spawns inside. Published closures are immutable, so
 * the loader drops those here rather than waiting for every map to be
 * republished.
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
  const sourceBytes = await sourceResponse.arrayBuffer();
  const manifest = await manifestResponse.json() as DerivativeManifest;
  if (!isSha256(manifest.sourceManifestSha256) || await sha256Hex(sourceBytes) !== manifest.sourceManifestSha256) {
    throw new Error('Static collision derivative targets a stale map bundle');
  }
  const variant = manifest.variants?.['static-colliders'];
  if (variant?.schemaVersion !== 1 || typeof variant.file !== 'string' || !isSha256(variant.outputSha256)) {
    throw new Error('Static collision derivative is not published for this map');
  }
  const artifactUrl = new URL(variant.file, new URL('.', derivativeUrl)).toString();
  const artifactResponse = await fetcher(artifactUrl);
  if (!artifactResponse.ok) throw new Error(`Static collision artifact unavailable (${artifactResponse.status})`);
  const bytes = await artifactResponse.arrayBuffer();
  if (await sha256Hex(bytes) !== variant.outputSha256) throw new Error('Static collision artifact checksum mismatch');
  const artifact = JSON.parse(new TextDecoder().decode(bytes)) as StaticColliderArtifact;
  validateArtifact(artifact, manifest, variant.digest);
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

function validateArtifact(artifact: StaticColliderArtifact, manifest: DerivativeManifest, expectedDigest?: string): void {
  if (!artifact || artifact.schema !== SCHEMA || typeof artifact.mapId !== 'string') throw new Error('Static collision artifact has an unsupported schema');
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

/**
 * Digest collider bytes with the engine's pure-TS SHA-256, never `crypto.subtle`.
 *
 * `crypto.subtle` exists only in a secure context, so on a plain-HTTP origin
 * that is not `localhost` — any LAN address or tunnelled host — it is
 * `undefined` and this threw "Cannot read properties of undefined (reading
 * 'digest')". The loader then reported the collider bundle as unavailable, the
 * compile failed closed, and the editor could never start a world. Serving over
 * HTTPS would also fix it, but requiring TLS to open a dev map is the wrong
 * constraint, and `packages/engine/src/core/hash.ts` was written for exactly
 * this reason: identical digests in the browser and in headless Node with no
 * platform branch.
 */
async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return sha256Bytes(new Uint8Array(data));
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
