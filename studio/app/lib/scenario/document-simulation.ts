import "server-only";

import { resolveScenarioMap, type ScenarioSimulationStatusDto } from "@simforge-oss/studio-host";

import type { AppContext } from "@/app/lib/db/app-context";

import { getScenarioDocument, listScenarioMapDescriptors } from "./document-store";
import { resolveSimulation } from "./sim-result-store";

/**
 * The authoritative simulation of a document's current draft, on the map
 * version the editor plays it on and a revision would freeze it to (today's
 * compatible publication of the draft's map). The editor compares its local
 * preview against this; nothing the client uploads takes part.
 */
export async function resolveDocumentSimulation(
  context: AppContext,
  documentId: string,
  options: { expectedVersion?: number; waitMs?: number } = {},
): Promise<
  | { kind: "not_found" }
  | { kind: "conflict"; draftVersion: number }
  | { kind: "status"; draftVersion: number; status: ScenarioSimulationStatusDto }
> {
  const document = await getScenarioDocument(context, documentId);
  if (!document) return { kind: "not_found" };
  if (options.expectedVersion !== undefined && document.draftVersion !== options.expectedVersion) {
    return { kind: "conflict", draftVersion: document.draftVersion };
  }
  const map = resolveScenarioMap(document, await listScenarioMapDescriptors(context));
  const status = await resolveSimulation({
    workspaceId: context.workspaceId,
    userId: context.userId,
    canonicalContent: document.content,
    contentSha256: document.contentSha256,
    mapVersionId: map.mapVersionId,
  }, { waitMs: options.waitMs ?? 0 });
  return { kind: "status", draftVersion: document.draftVersion, status };
}
