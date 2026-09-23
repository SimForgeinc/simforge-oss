import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { RenderSensorSourceHost } from '@simforge-oss/scenario';
import { getEntry, isCatalogId } from '@simforge-oss/asset-catalog/metadata';

import { markBlobVerified, verifyCachedBlob } from '../blob-cache.js';
import type { NativeActorAppearance } from './lowering.js';

/**
 * The native actor closure travels on every native intent as one explicit
 * asset/input, `actors.native-closure`: the immutable closure document whose
 * digest the intent hash binds. Each member the document lists is
 * content-addressed under the blob origin (`blobs/sha256/<aa>/<sha256>`), so
 * the origin is configurable while the rendered bytes cannot drift from the
 * declared identity. Local Studio, Cloud, and the standalone intent script
 * all declare the same asset through {@link nativeActorAssetsInput}.
 */
export const NATIVE_ACTOR_ASSETS_INPUT_ID = 'actors.native-closure';
export const NATIVE_ACTOR_ASSETS_RELATIVE_PATH = 'actor-assets/closure.json';
export const NATIVE_ACTOR_ASSETS_CLOSURE_SCHEMA = 'simforge.actor-assets-closure/v1';
/** The closure member the retained service resolves catalog ids through. */
export const NATIVE_ACTOR_ASSETS_CATALOG_PATH = 'catalog-models.json';

/**
 * The immutable actor closure: sha256 and byte size of the closure document
 * `actor-assets/closures/<digest>.json` as served by the origin.
 *
 * `70dde8bb` carries the CARLA 0.10.0-UE5 vehicle and pedestrian geometry: 68
 * of its 165 catalog entries are `carla-0.10.0-ue5` (805.9 MiB of its 1,288.9
 * MiB of distinct blobs), and the 35 generated and 62 procedural entries no CARLA
 * model covers are carried over unchanged. It is not on the public origin: an
 * install resolves it from a packaged `share/actor-assets` directory or
 * `SIMFORGE_ACTOR_ASSETS_ROOT` until a maintainer uploads the closure document
 * and its blobs.
 */
export const PINNED_ACTOR_ASSETS_DIGEST = '70dde8bb17ac3595d3e6c307dce8bf42f2d8fbcfb13bddd781f5cfe4daef18b4';
export const PINNED_ACTOR_ASSETS_SIZE_BYTES = 22969;
export const DEFAULT_ACTOR_ASSETS_BASE_URL = 'https://da3tufozhdsvl.cloudfront.net';


export interface NativeActorAssetsInput {
  readonly inputId: typeof NATIVE_ACTOR_ASSETS_INPUT_ID;
  readonly relativePath: typeof NATIVE_ACTOR_ASSETS_RELATIVE_PATH;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
}

/**
 * The origin root. The published layout is `<origin>/actor-assets/closures/<digest>.json`
 * and `<origin>/actor-assets/blobs/sha256/<aa>/<sha256>`. Operators have configured
 * the base both as the origin and as `<origin>/actor-assets`, so a trailing
 * `/actor-assets` is folded away: either spelling reaches the same objects.
 * A `file://` base is a packaged closure directory holding `blobs/` directly.
 */
export function actorAssetsBaseUrl(configured?: string): string {
  const base = (configured ?? process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL ?? DEFAULT_ACTOR_ASSETS_BASE_URL).replace(/\/+$/u, '');
  return base.startsWith('file://') ? base : base.replace(/\/actor-assets$/u, '');
}

export function actorAssetsClosureUrl(digest: string, baseUrl?: string): string {
  return `${actorAssetsBaseUrl(baseUrl)}/actor-assets/closures/${digest}.json`;
}

/** Where a closure member's bytes are served; see {@link actorAssetsBaseUrl}. */
export function actorAssetBlobUrl(sha256: string, baseUrl?: string): string {
  const base = actorAssetsBaseUrl(baseUrl);
  const prefix = base.startsWith('file://') ? base : `${base}/actor-assets`;
  return `${prefix}/blobs/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * The pinned actor closure as an intent asset / lease input. The origin may
 * be configured (`SIMFORGE_ACTOR_ASSETS_BASE_URL`); the identity is fixed.
 */
export function nativeActorAssetsInput(options: { readonly baseUrl?: string } = {}): NativeActorAssetsInput {
  return {
    inputId: NATIVE_ACTOR_ASSETS_INPUT_ID,
    relativePath: NATIVE_ACTOR_ASSETS_RELATIVE_PATH,
    sha256: PINNED_ACTOR_ASSETS_DIGEST,
    sizeBytes: PINNED_ACTOR_ASSETS_SIZE_BYTES,
    downloadUrl: actorAssetsClosureUrl(PINNED_ACTOR_ASSETS_DIGEST, options.baseUrl),
  };
}

/**
 * The writable, persistent actor blob cache: `SIMFORGE_ACTOR_ASSETS_CACHE_DIR`,
 * else `<SIMFORGE_CACHE_DIR>/actor-assets` (the worker's cache mount), else
 * `fallback`.
 */
export function nativeActorAssetsCacheDir(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR?.trim();
  if (explicit) return explicit;
  const cache = env.SIMFORGE_CACHE_DIR?.trim();
  return cache ? path.join(cache, 'actor-assets') : fallback;
}

export interface ActorClosureMember { readonly sha256: string; readonly bytes: number }

/** A catalog id's model as `catalog-models.json` declares it, every path a closure member. */
export interface ActorClosureModel {
  readonly catalogId: string;
  readonly glbPath: string;
  readonly animationPaths: readonly string[];
}

export interface ActorAssetsClosure {
  readonly digest: string;
  readonly sizeBytes: number;
  readonly members: ReadonlyMap<string, ActorClosureMember>;
}

export interface VerifiedActorAssets extends ActorAssetsClosure {
  /** Per-job directory holding exactly the closure members. */
  readonly directory: string;
  /** Catalog ids the service can bind to a verified closure model. */
  readonly models: ReadonlyMap<string, ActorClosureModel>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function safeMemberPath(memberPath: string): string[] {
  const parts = memberPath.split('/');
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error(`unsafe actor asset closure path: ${memberPath}`);
  }
  return parts;
}

/**
 * Parses closure bytes against their declared identity. The document is the
 * identity: its sha256 is what the intent binds and what the manifest and
 * diagnostics report.
 */
export function parseActorAssetsClosure(
  bytes: Uint8Array,
  declared: { readonly sha256: string; readonly sizeBytes: number },
): ActorAssetsClosure {
  const digest = sha256(bytes);
  if (digest !== declared.sha256 || bytes.byteLength !== declared.sizeBytes) {
    throw new Error(`actor asset closure does not match its declared identity: expected ${declared.sha256}/${declared.sizeBytes}, got ${digest}/${bytes.byteLength}`);
  }
  const document = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    schema?: unknown;
    members?: Record<string, { sha256?: unknown; bytes?: unknown }>;
  };
  if (document.schema !== NATIVE_ACTOR_ASSETS_CLOSURE_SCHEMA || !document.members || typeof document.members !== 'object' || Array.isArray(document.members)) {
    throw new Error('unsupported actor asset closure schema');
  }
  const members = new Map<string, ActorClosureMember>();
  for (const [memberPath, member] of Object.entries(document.members).sort(([left], [right]) => left.localeCompare(right))) {
    safeMemberPath(memberPath);
    if (typeof member?.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(member.sha256)
      || typeof member.bytes !== 'number' || !Number.isInteger(member.bytes) || member.bytes < 0) {
      throw new Error(`actor asset closure member ${memberPath} lacks a sha256/bytes identity`);
    }
    members.set(memberPath, { sha256: member.sha256, bytes: member.bytes });
  }
  if (!members.has(NATIVE_ACTOR_ASSETS_CATALOG_PATH)) {
    throw new Error(`actor asset closure ${digest} lacks ${NATIVE_ACTOR_ASSETS_CATALOG_PATH}`);
  }
  return { digest, sizeBytes: bytes.byteLength, members };
}

/**
 * `catalog-models.json` as the retained service reads it (`vehicle_model.rs`
 * `from_sidecar`): `{ "<catalogId>": { model: { glbPath }, animations?: {
 * <name>: { glbPath } } } }`, flat `{ glbPath }` entries accepted, keys
 * without a dot being wrapper metadata. Every referenced path must be a
 * closure member, otherwise the service would retain a proxy for an id the
 * catalog claims to model.
 */
export function parseActorClosureCatalog(
  bytes: Uint8Array,
  members: ReadonlyMap<string, ActorClosureMember>,
): ReadonlyMap<string, ActorClosureModel> {
  const raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
  const table = (raw.models ?? raw.entries ?? raw) as Record<string, unknown>;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`${NATIVE_ACTOR_ASSETS_CATALOG_PATH}: expected an object`);
  }
  const models = new Map<string, ActorClosureModel>();
  for (const [catalogId, value] of Object.entries(table)) {
    if (!catalogId.includes('.') || !value || typeof value !== 'object') continue;
    const entry = value as { model?: { glbPath?: unknown }; glbPath?: unknown; animations?: Record<string, { glbPath?: unknown }> };
    const glbPath = entry.model?.glbPath ?? entry.glbPath;
    if (typeof glbPath !== 'string') continue;
    if (!members.has(glbPath)) {
      throw new Error(`${NATIVE_ACTOR_ASSETS_CATALOG_PATH} binds ${catalogId} to ${glbPath}, which is not a closure member`);
    }
    const animationPaths: string[] = [];
    for (const [name, animation] of Object.entries(entry.animations ?? {})) {
      if (typeof animation?.glbPath !== 'string') {
        throw new Error(`${NATIVE_ACTOR_ASSETS_CATALOG_PATH} animation ${catalogId}/${name} lacks a glbPath`);
      }
      if (!members.has(animation.glbPath)) {
        throw new Error(`${NATIVE_ACTOR_ASSETS_CATALOG_PATH} binds ${catalogId}/${name} to ${animation.glbPath}, which is not a closure member`);
      }
      animationPaths.push(animation.glbPath);
    }
    models.set(catalogId, { catalogId, glbPath, animationPaths });
  }
  return models;
}

/**
 * Refuses a render whose appearance would silently downgrade to a proxy:
 * every authored identity must declare a procedural builder or bind a verified
 * closure model. A missing model alone never declares procedural intent.
 * Every sensor host's contract identity must match the identity rendered for
 * that actor. Unauthored semantic defaults keep the documented class primitive.
 */
export function assertActorAppearanceGrounded(
  appearances: readonly NativeActorAppearance[],
  sensorHosts: readonly RenderSensorSourceHost[],
  assets: Pick<VerifiedActorAssets, 'digest' | 'models'>,
): void {
  const byActor = new Map(appearances.map((appearance) => [appearance.actorId, appearance]));
  for (const host of sensorHosts) {
    const appearance = byActor.get(host.actorId);
    if (!appearance) {
      throw new Error(`sensor host ${host.sourceId} rides actor ${host.actorId}, which is never present in the lowered scenario`);
    }
    if (appearance.catalogId !== host.vehicleAsset.catalogAssetId) {
      throw new Error(`sensor host ${host.sourceId} identifies actor ${host.actorId} as ${host.vehicleAsset.catalogAssetId}, but the scenario renders it as ${appearance.catalogId}`);
    }
  }
  const hostActorIds = new Set(sensorHosts.map((host) => host.actorId));
  for (const appearance of appearances) {
    if (!(appearance.authored || hostActorIds.has(appearance.actorId))) continue;
    const procedural = isCatalogId(appearance.catalogId)
      && Boolean(getEntry(appearance.catalogId).proceduralBuilder);
    if (procedural || assets.models.has(appearance.catalogId)) continue;
    throw new Error(`actor ${appearance.actorId} requires catalog model ${appearance.catalogId}, which actor closure ${assets.digest} does not provide`);
  }
}

function blobPath(cacheRoot: string, member: ActorClosureMember): string {
  return path.join(cacheRoot, 'blobs', 'sha256', member.sha256.slice(0, 2), member.sha256);
}

async function downloadBlob(baseUrl: string, member: ActorClosureMember, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const url = actorAssetBlobUrl(member.sha256, baseUrl);
  if (url.startsWith('file://')) {
    await fs.copyFile(new URL(url), temporary);
  } else {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`actor asset blob download failed ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body as never), await fs.open(temporary, 'w').then((file) => file.createWriteStream()));
  }
  const actual = await hashFile(temporary);
  if (actual.bytes !== member.bytes || actual.sha256 !== member.sha256) {
    await fs.rm(temporary, { force: true });
    throw new Error(`actor asset blob digest mismatch: expected ${member.sha256}/${member.bytes}, got ${actual.sha256}/${actual.bytes}`);
  }
  await markBlobVerified(temporary, member.sha256);
  await fs.rename(temporary, destination);
}

/** In-flight verification/download per blob path, so concurrent jobs share one fetch and never race a rename. */
const inflight = new Map<string, Promise<void>>();

/**
 * Proves the cached blob is the member's bytes, downloading it when absent
 * or corrupt. A blob is hashed when it is written; later jobs prove it is
 * unmodified with its verification stamp (`SIMFORGE_CACHE_VERIFY=full`
 * re-hashes every job). The cache is an optimisation, never an authority:
 * a blob that fails verification is replaced from the origin.
 */
function verifiedBlob(baseUrl: string, member: ActorClosureMember, destination: string): Promise<void> {
  const pending = inflight.get(destination);
  if (pending) return pending;
  const work = (async () => {
    if (existsSync(destination)) {
      if (await verifyCachedBlob(destination, member.sha256, member.bytes)) return;
      await fs.rm(destination, { force: true });
    }
    await downloadBlob(baseUrl, member, destination);
  })().finally(() => inflight.delete(destination));
  inflight.set(destination, work);
  return work;
}

/** Installed immutable inputs can be readable without permitting hard links. */
export async function linkOrCopy(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.link(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM') throw error;
    await fs.copyFile(source, target);
  }
}

export interface EnsureActorAssetsOptions {
  /** The downloaded `actors.native-closure` input: the closure document and its declared identity. */
  readonly closure: { readonly path: string; readonly sha256: string; readonly sizeBytes: number };
  /** Job-private directory that receives exactly the closure members; replaced if present. */
  readonly destination: string;
  readonly baseUrl?: string;
  readonly cacheDir?: string;
  /**
   * When set, the closure tree is laid out once per closure digest under
   * `<treeRoot>/<digest>` (hard links into the blob cache, so it costs no
   * bytes) and shared read-only by every later job, instead of a per-job
   * copy under `destination`. Must be on the same filesystem as the cache
   * for the links to be free.
   */
  readonly treeRoot?: string;
}

const TREE_COMPLETE_MARKER = '.simforge-closure-complete';

/** A tree member is valid when it is the verified blob itself (same inode) or carries its own stamp. */
async function treeMemberValid(treeFile: string, blobFile: string, member: ActorClosureMember): Promise<boolean> {
  const [tree, blob] = await Promise.all([fs.stat(treeFile).catch(() => null), fs.stat(blobFile).catch(() => null)]);
  if (!tree?.isFile() || tree.size !== member.bytes) return false;
  if (blob && blob.ino === tree.ino && blob.dev === tree.dev) return true;
  return verifyCachedBlob(treeFile, member.sha256, member.bytes);
}

async function reuseSharedTree(directory: string, cacheRoot: string, closure: ActorAssetsClosure): Promise<boolean> {
  if (!existsSync(path.join(directory, TREE_COMPLETE_MARKER))) return false;
  const entries = [...closure.members];
  let cursor = 0;
  let valid = true;
  await Promise.all(Array.from({ length: Math.min(16, entries.length) }, async () => {
    while (valid && cursor < entries.length) {
      const [memberPath, member] = entries[cursor++]!;
      if (!await treeMemberValid(path.join(directory, ...safeMemberPath(memberPath)), blobPath(cacheRoot, member), member)) valid = false;
    }
  }));
  if (valid) {
    const now = new Date();
    await fs.utimes(directory, now, now).catch(() => undefined);
  }
  return valid;
}

/**
 * Materializes the closure a job's intent binds: verifies the closure
 * document against its declared digest and size, proves every member's
 * bytes (from the shared content-addressed cache or the blob origin), and
 * lays the members out under `destination` as a fresh, exact tree. No marker
 * or memoised promise stands in for verification on a later job.
 */
export async function ensureActorAssets(options: EnsureActorAssetsOptions): Promise<VerifiedActorAssets> {
  const closure = parseActorAssetsClosure(await fs.readFile(options.closure.path), options.closure);
  const baseUrl = actorAssetsBaseUrl(options.baseUrl);
  const cacheRoot = options.cacheDir ?? process.env.SIMFORGE_ACTOR_ASSETS_CACHE_DIR
    ?? path.join(process.env.SIMFORGE_CACHE_DIR ?? '/tmp/simforge-cache', 'actor-assets');

  const entries = [...closure.members];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const [, member] = entries[cursor++]!;
      await verifiedBlob(baseUrl, member, blobPath(cacheRoot, member));
    }
  }));

  const sharedTree = options.treeRoot ? path.join(options.treeRoot, closure.digest) : null;
  let directory = options.destination;
  if (sharedTree && await reuseSharedTree(sharedTree, cacheRoot, closure)) {
    directory = sharedTree;
  } else {
    const target = sharedTree ?? options.destination;
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.rm(temporary, { recursive: true, force: true });
    for (const [memberPath, member] of entries) {
      await linkOrCopy(blobPath(cacheRoot, member), path.join(temporary, ...safeMemberPath(memberPath)));
    }
    if (sharedTree) await fs.writeFile(path.join(temporary, TREE_COMPLETE_MARKER), `${closure.digest}\n`);
    await fs.rm(target, { recursive: true, force: true });
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      // A co-located worker published the same tree first; ours is redundant.
      const code = (error as NodeJS.ErrnoException).code;
      if (!sharedTree || (code !== 'ENOTEMPTY' && code !== 'EEXIST')) throw error;
      await fs.rm(temporary, { recursive: true, force: true });
      if (!await reuseSharedTree(sharedTree, cacheRoot, closure)) throw error;
    }
    directory = target;
  }

  const catalogMember = closure.members.get(NATIVE_ACTOR_ASSETS_CATALOG_PATH)!;
  const catalogBytes = await fs.readFile(path.join(directory, NATIVE_ACTOR_ASSETS_CATALOG_PATH));
  if (sha256(catalogBytes) !== catalogMember.sha256) {
    throw new Error(`materialized ${NATIVE_ACTOR_ASSETS_CATALOG_PATH} does not match closure ${closure.digest}`);
  }
  return { ...closure, directory, models: parseActorClosureCatalog(catalogBytes, closure.members) };
}

/**
 * Downloads (and verifies) every member blob of the closure into the cache
 * without laying out a tree: the worker's background prewarm.
 */
export async function prewarmActorAssets(options: {
  readonly closureBytes: Uint8Array;
  readonly declared: { readonly sha256: string; readonly sizeBytes: number };
  readonly baseUrl?: string;
  readonly cacheDir: string;
  readonly concurrency?: number;
  readonly onBlob?: (member: ActorClosureMember) => void;
}): Promise<{ members: number; bytes: number }> {
  const closure = parseActorAssetsClosure(options.closureBytes, options.declared);
  const baseUrl = actorAssetsBaseUrl(options.baseUrl);
  const entries = [...closure.members.values()];
  let cursor = 0;
  let bytes = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 2, entries.length) }, async () => {
    while (cursor < entries.length) {
      const member = entries[cursor++]!;
      await verifiedBlob(baseUrl, member, blobPath(options.cacheDir, member));
      bytes += member.bytes;
      options.onBlob?.(member);
    }
  }));
  return { members: entries.length, bytes };
}

