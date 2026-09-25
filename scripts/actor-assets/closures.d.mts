// Types for closures.mjs (content-addressed asset closures for repository tooling).
export interface Identity { readonly sha256: string; readonly bytes: number }
export interface MemberLicense { readonly license: string; readonly attribution?: string; readonly source?: string }
export interface ParsedClosure {
  readonly digest: string;
  readonly bytes: number;
  readonly members: ReadonlyMap<string, Identity>;
  /** The optional `licenses` table (empty when the closure records none). */
  readonly licenses: ReadonlyMap<string, MemberLicense>;
}
export interface StoreOptions { readonly origin?: string; readonly cacheDir?: string }

export const CLOSURE_SCHEMA: 'simforge.actor-assets-closure/v1';
export const LOCK_SCHEMA: 'simforge.asset-closures-lock/v1';
export const DEFAULT_ORIGIN: string;
export const TREE_COMPLETE_MARKER: string;
export const LOCK_PATH: string;

export class AssetUnavailableError extends Error {
  readonly code: 'asset_unavailable';
  readonly details: Record<string, unknown>;
}

export function canonicalJson(value: unknown): string;
export function sha256Bytes(bytes: Uint8Array): string;
export function hashFile(file: string): Promise<Identity>;
export function assetsOrigin(configured?: string): string;
export function blobUrl(sha256: string, origin?: string): string;
export function closureUrl(digest: string, origin?: string): string;
export function cacheRoot(env?: NodeJS.ProcessEnv): string;
export function blobCachePath(sha256: string, cacheDir?: string): string;
export function parseClosure(bytes: Uint8Array, declared: Identity): ParsedClosure;
export const UNCONFIRMED_LICENSE: 'UNCONFIRMED';
export function sealClosure(
  members: Readonly<Record<string, Identity>>,
  options?: { readonly licenses?: Readonly<Record<string, MemberLicense>> },
): { readonly bytes: Buffer; readonly sha256: string; readonly size: number };
/** Members a public distribution may not carry: no licence recorded, or UNCONFIRMED. */
export function unlicensedMembers(closure: ParsedClosure): string[];
export function pullBlob(identity: Identity, options?: StoreOptions): Promise<string>;
export function pullClosureDocument(identity: Identity, options?: StoreOptions): Promise<{ readonly path: string; readonly closure: ParsedClosure }>;
export function materializeClosure(
  identity: Identity,
  options?: StoreOptions & { readonly concurrency?: number; readonly onBlob?: (memberPath: string, member: Identity) => void },
): Promise<{ readonly directory: string; readonly closure: ParsedClosure }>;
export interface Lock {
  readonly schema: string;
  readonly origin: string;
  readonly closures: Readonly<Record<string, Identity & { readonly document?: string }>>;
}
export function readLock(lockPath?: string): Lock;
export function lockedClosure(name: string, lock?: Lock): Identity & { readonly document?: string };
export function pullPinned(name: string, options?: StoreOptions & { readonly lockPath?: string }): Promise<string>;
/** The sealed closure of a pack as git records it (`catalog/<pack>/closure.json`, verified against the lock). */
export function packClosure(name: string, lock?: Lock): ParsedClosure;
/** Offline: the directory of a pinned closure already materialized in the cache; throws naming the pull command otherwise. */
export function pinnedDirSync(name: string, options?: { readonly cacheDir?: string; readonly lockPath?: string }): string;
