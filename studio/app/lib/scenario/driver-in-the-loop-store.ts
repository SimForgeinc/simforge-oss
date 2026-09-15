import type { AppContext } from "@/app/lib/db/app-context";
import type { ScenarioDocumentDto } from "./contracts";
import {
  duplicateScenarioDocument,
  getScenarioDocument,
  listScenarioDocuments,
} from "./document-store";
import { driverInTheLoopContent, driverInTheLoopTitle, resolveDriverRole } from "./driver-in-the-loop";

export type StartDriverInTheLoopResult =
  | { kind: "created"; document: ScenarioDocumentDto; roleId: string }
  | { kind: "not_found" }
  | { kind: "not_drivable"; reason: string };

/**
 * Start a Driver in the Loop drive: create the variation the human will drive.
 *
 * The variation is created before the drive rather than after it, so the drive
 * has a document to write its recorded clip into, and a refusal — an unpinned
 * scenario, no drivable vehicle, an ambiguous ego — is answered with a reason
 * before anything exists. The variation lands in its parent's dataset; the
 * caller has already authorized both the copy and the write there.
 */
export async function startDriverInTheLoop(
  context: AppContext,
  documentId: string,
  requestedRoleId?: string,
): Promise<StartDriverInTheLoopResult> {
  const base = await getScenarioDocument(context, documentId);
  if (!base) return { kind: "not_found" };
  const role = resolveDriverRole(base.content, requestedRoleId);
  if (!role.ok) return { kind: "not_drivable", reason: role.reason };
  const siblings = await listScenarioDocuments(context, 200, base.datasetId);
  const result = await duplicateScenarioDocument(context, documentId, {
    derivation: "variation",
    title: driverInTheLoopTitle(base.title, siblings.map((sibling) => sibling.title)),
    content: driverInTheLoopContent(base.content, role.roleId),
  });
  return result.kind === "created" ? { kind: "created", document: result.document, roleId: role.roleId } : result;
}
