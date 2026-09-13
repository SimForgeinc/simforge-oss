import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EVIDENCE_DIR } from "./paths";

/**
 * Anything that can say where evidence belongs: an {@link E2eContext} (has
 * `evidenceDir`), a Playwright `TestInfo` (has `outputDir` and `attach`), or
 * nothing, in which case evidence lands in a `standalone` run directory.
 */
export type EvidenceTarget =
  | { evidenceDir: string; id?: string }
  | { outputDir: string; title?: string; attach?: (name: string, options: { body?: string | Buffer; contentType?: string }) => Promise<void>; annotations?: { type: string; description?: string }[] }
  | undefined;

let activeTestInfo: EvidenceTarget | undefined;

/** The fixtures register the running test so `writeEvidence(ctx, …)` can also attach. */
export function setActiveEvidenceTarget(target: EvidenceTarget): void {
  activeTestInfo = target;
}

function evidenceDirectory(target: EvidenceTarget): string {
  if (target && "evidenceDir" in target && typeof target.evidenceDir === "string") return target.evidenceDir;
  if (target && "outputDir" in target && typeof target.outputDir === "string") return target.outputDir;
  return join(EVIDENCE_DIR, "standalone");
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error(`Evidence name ${JSON.stringify(name)} has no usable characters`);
  return cleaned.endsWith(".json") ? cleaned : `${cleaned}.json`;
}

/**
 * Write one structured evidence document and attach it to the running test.
 * Key order is stable and the payload is pretty-printed, so two runs of the
 * same deterministic flow produce byte-identical files.
 */
export async function writeEvidence(target: EvidenceTarget, name: string, payload: unknown): Promise<string> {
  const directory = evidenceDirectory(target);
  const file = resolve(directory, safeName(name));
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(directory, { recursive: true });
  await writeFile(file, body, "utf8");
  const attachable = target && "attach" in target && typeof target.attach === "function"
    ? target
    : activeTestInfo && "attach" in activeTestInfo && typeof activeTestInfo.attach === "function"
      ? activeTestInfo
      : undefined;
  if (attachable?.attach) await attachable.attach(safeName(name), { body, contentType: "application/json" });
  return file;
}

/** Alias of {@link writeEvidence} for call sites that read better as a recorder. */
export const recordEvidence = writeEvidence;
