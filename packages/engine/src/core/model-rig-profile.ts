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

import {
  type ActualCaptureSensor,
  capturePayloadFromSensors,
  expectedCapturePayload,
  modelRequirementPayload,
} from '@simforge-oss/scenario';

import { canonicalJson, sha256 } from './hash.js';

/**
 * SHA-256 of the EXPECTED capture profile for a rig id - the unedited
 * preset. A recommendation to show before a render exists; NOT the identity
 * of a capture that happened, because an authored FOV or mount edit does
 * not change it.
 */
export function expectedCaptureHash(rigId: string): string {
  return sha256(canonicalJson(expectedCapturePayload(rigId)));
}

/**
 * SHA-256 of what was ACTUALLY captured: the sensors the render used, with
 * their authored edits, and the camera subset fed to the model. This is the
 * value a comparison must key on. Family-independent by construction, so
 * two models over one capture share it.
 */
export function captureHashFromSensors(input: {
  readonly sensors: readonly ActualCaptureSensor[];
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly framesPerCamera: number;
  readonly historySteps: number;
  readonly coordinateFrame: string;
  readonly rigLabel?: string;
}): string {
  return sha256(canonicalJson(capturePayloadFromSensors(input)));
}

/**
 * Short persisted tag for an actual capture. Prefixed `capture@` rather
 * than with a rig name, because the rig name is a label two authors can
 * disagree on while the digest settles identity.
 */
export function captureVersionFromSensors(
  input: Parameters<typeof captureHashFromSensors>[0],
): string {
  return `capture@${captureHashFromSensors(input).slice(0, 12)}`;
}

/** SHA-256 of a family's binding to a capture profile. */
export function modelRequirementHash(family: string): string {
  return sha256(canonicalJson(modelRequirementPayload(family)));
}

/** Short persisted tag for a model's requirement binding. */
export function modelRequirementVersion(family: string): string {
  return `${family}@${modelRequirementHash(family).slice(0, 12)}`;
}
