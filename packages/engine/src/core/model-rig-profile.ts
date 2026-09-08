/**
 * Hashes for the two identities a comparison needs to keep apart.
 *
 * CAPTURE identity is what was physically recorded: rig, camera ids,
 * cadence, history window, sensor geometry. MODEL REQUIREMENT identity is
 * which capture a family binds to and on what terms. They are hashed
 * separately because the same four-camera capture is the same capture
 * whether A1 or A1.5 consumed it - a single family-prefixed value would
 * make two runs over identical imagery look sensor-different and stop them
 * being ranked.
 *
 * Both live here rather than beside the payloads because this package owns
 * content hashing and the dependency runs engine -> scenario, so one
 * primitive serves both instead of a second SHA-256 appearing downstream.
 */

import { captureProfilePayload, modelRequirementPayload } from '@simforge-oss/scenario';

import { canonicalJson, sha256 } from './hash.js';

/** SHA-256 of a rig's capture profile. Family-independent by construction. */
export function captureProfileHash(rigId: string): string {
  return sha256(canonicalJson(captureProfilePayload(rigId)));
}

/**
 * Short persisted tag for a capture. Prefixed with the RIG id, not a model
 * family, so it reads correctly for a capture two models can share.
 */
export function captureProfileVersion(rigId: string): string {
  return `${rigId}@${captureProfileHash(rigId).slice(0, 12)}`;
}

/** SHA-256 of a family's binding to a capture profile. */
export function modelRequirementHash(family: string): string {
  return sha256(canonicalJson(modelRequirementPayload(family)));
}

/** Short persisted tag for a model's requirement binding. */
export function modelRequirementVersion(family: string): string {
  return `${family}@${modelRequirementHash(family).slice(0, 12)}`;
}
