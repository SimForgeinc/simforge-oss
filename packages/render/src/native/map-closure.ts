import { createHash } from 'node:crypto';

/**
 * Native map closure members as they travel on a v2 lease.
 *
 * Both control planes derive member input ids from the member's closure
 * path: `master.gltf` is `map.tile.000000`, every other member is
 * `map.resource.<sha256(relativePath)>`. That derivation is the binding
 * between an immutable blob digest and the path the master's `buffers[].uri`
 * / `images[].uri` resolve against, so an input whose id does not derive
 * from its `relativePath` is a tampered or misrouted member and is refused
 * before any byte is downloaded or written under `workspace/map`.
 */
export const NATIVE_MAP_MASTER_INPUT_ID = 'map.tile.000000';
export const NATIVE_MAP_MASTER_PATH = 'master.gltf';

const NATIVE_MAP_RESOURCE_INPUT_PATTERN = /^map\.resource\.[a-f0-9]{64}$/u;

export interface NativeMapMemberInput {
  readonly inputId: string;
  readonly relativePath?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface NativeMapClosure<T extends NativeMapMemberInput> {
  /** Every member including `master.gltf`, keyed by closure-relative path. */
  readonly members: ReadonlyMap<string, T>;
}

export function nativeMapMemberInputId(relativePath: string): string {
  if (relativePath === NATIVE_MAP_MASTER_PATH) return NATIVE_MAP_MASTER_INPUT_ID;
  return `map.resource.${createHash('sha256').update(relativePath, 'utf8').digest('hex')}`;
}

export function isNativeMapMemberInputId(inputId: string): boolean {
  return inputId === NATIVE_MAP_MASTER_INPUT_ID || NATIVE_MAP_RESOURCE_INPUT_PATTERN.test(inputId);
}

export function assertSafeNativeMapMemberPath(relativePath: string): void {
  if (/[\\:%?#\u0000-\u001f]/u.test(relativePath)
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid unsafe native map member path: ${relativePath}`);
  }
}

/**
 * Selects the native map members among `inputs` and proves they form a
 * well-formed closure: a `master.gltf` master, unique safe member paths,
 * and every member id derived from its own path. Inputs whose id is not a
 * native member id (`scenario.xosc`, CARLA assets) are left to the caller.
 *
 * Digest/size immutability is proven elsewhere: the intent declares every
 * member as its own asset, so the intent hash binds the served closure, and
 * the transfer layer hashes every downloaded byte.
 */
export function collectNativeMapMembers<T extends NativeMapMemberInput>(inputs: Iterable<T>): NativeMapClosure<T> {
  const members = new Map<string, T>();
  for (const input of inputs) {
    if (!isNativeMapMemberInputId(input.inputId)) continue;
    const relativePath = input.relativePath;
    if (relativePath === undefined) throw new Error(`invalid native map member ${input.inputId} without relativePath`);
    assertSafeNativeMapMemberPath(relativePath);
    if (nativeMapMemberInputId(relativePath) !== input.inputId) {
      throw new Error(`invalid native map member ${input.inputId} does not derive from its path ${relativePath}`);
    }
    if (members.has(relativePath)) throw new Error(`invalid duplicate native map member ${relativePath}`);
    members.set(relativePath, input);
  }
  if (!members.has(NATIVE_MAP_MASTER_PATH)) {
    throw new Error(`invalid missing native map member ${NATIVE_MAP_MASTER_INPUT_ID} (${NATIVE_MAP_MASTER_PATH})`);
  }
  return { members };
}
