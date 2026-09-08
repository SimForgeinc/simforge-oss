/**
 * Hash and version tag for a model's required camera profile.
 *
 * Lives here rather than in `@simforge-oss/scenario` because that package
 * owns the rig geometry and this one owns content hashing - and the
 * dependency runs engine -> scenario, so the hash cannot live beside the
 * payload without either inverting the graph or adding a second SHA-256
 * implementation. Reusing `core/hash` keeps one hash function in the repo.
 *
 * The version is persisted in render and evaluation manifests so a stored
 * result names the exact profile it was produced under. Edit a camera
 * template's FOV or mount and this changes, which stops an old result from
 * claiming to match the new profile.
 */

import { modelRigProfilePayload } from '@simforge-oss/scenario';

import { canonicalJson, sha256 } from './hash.js';

/** Full SHA-256 of a family's rig profile payload. */
export function modelRigProfileHash(family: string): string {
  return sha256(canonicalJson(modelRigProfilePayload(family)));
}

/**
 * Short persisted tag: family plus the first 12 hex of the hash. Short
 * enough for a manifest field and a UI badge, and it changes whenever the
 * geometry or the input contract changes.
 */
export function modelRigProfileVersion(family: string): string {
  return `${family}@${modelRigProfileHash(family).slice(0, 12)}`;
}
