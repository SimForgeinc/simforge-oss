import { createHash, randomUUID } from "node:crypto";
import { canonicalize, serializeTemplate, simContentHash, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalContentSha256(value: ScenarioTemplateV2): string {
  return sha256(serializeTemplate(value));
}

/**
 * Simulation-relevant content identity of a template (`simContentHash`): the
 * document part of the compile/simulate cache key. Unlike `content_sha256`,
 * renames (once the seed is pinned), timestamps, descriptions and editor
 * presentation state do not change it.
 */
export function simContentSha256(value: ScenarioTemplateV2): string {
  return simContentHash(value);
}

/**
 * Legacy storage-grid digest (`JSON.stringify` of the quantized value). Stored
 * job/request digests were written with it, so it stays byte-stable; new
 * content identities use `canonicalSha256` / `simContentSha256`.
 */
export function canonicalJsonSha256(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function scenarioId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}
