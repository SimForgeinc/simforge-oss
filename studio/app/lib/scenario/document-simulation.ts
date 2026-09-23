import "server-only";

import type { ScenarioEngineChangeDto, ScenarioSimulationStatusDto } from "@simforge-oss/studio-host";

import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne } from "@/app/lib/db/data-api";

import { getScenarioDocument } from "./document-store";
import { verifyDraftSimulationPin } from "./map-pin";
import { recordDraftSimulation } from "./sim-history";
import { resolveSimulation } from "./sim-result-store";

/**
 * The authoritative simulation of a document's current draft, on its PINNED map version: the
 * version the editor plays it on and a revision freezes, superseded or not. The pin's closure and
 * asset catalog must still match (`verifyDraftSimulationPin`); a newer publication is offered to the
 * author as an explicit re-pin, never substituted. The editor compares its local preview against
 * this; nothing the client uploads takes part.
 *
 * When the draft is unchanged but its result changed (an engine upgrade), `engineChange` carries
 * the previous and current results and their motion diff for the editor's banner.
 */
export async function resolveDocumentSimulation(
  context: AppContext,
  documentId: string,
  options: { expectedVersion?: number; waitMs?: number } = {},
): Promise<
  | { kind: "not_found" }
  | { kind: "conflict"; draftVersion: number }
  | { kind: "status"; draftVersion: number; status: ScenarioSimulationStatusDto; engineChange: ScenarioEngineChangeDto | null }
> {
  const document = await getScenarioDocument(context, documentId);
  if (!document) return { kind: "not_found" };
  if (options.expectedVersion !== undefined && document.draftVersion !== options.expectedVersion) {
    return { kind: "conflict", draftVersion: document.draftVersion };
  }
  const pin = await verifyDraftSimulationPin({ queryOne }, document);
  const status = await resolveSimulation({
    workspaceId: context.workspaceId,
    userId: context.userId,
    canonicalContent: document.content,
    contentSha256: document.contentSha256,
    mapVersionId: pin.mapVersionId,
  }, { waitMs: options.waitMs ?? 0 });
  const engineChange = await recordDraftSimulation(context, documentId, document.draftVersion, status);
  return { kind: "status", draftVersion: document.draftVersion, status, engineChange };
}
