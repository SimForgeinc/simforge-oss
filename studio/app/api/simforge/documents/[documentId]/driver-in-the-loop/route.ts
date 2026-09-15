import { NextResponse } from "next/server";
import { DriverInTheLoopSchema } from "@/app/lib/scenario/contracts";
import {
  duplicateScenarioDocument,
  getScenarioDocument,
  listScenarioDocuments,
} from "@/app/lib/scenario/document-store";
import {
  driverInTheLoopContent,
  driverInTheLoopTitle,
  resolveDriverRole,
} from "@/app/lib/scenario/driver-in-the-loop";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutableDocumentContext,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

/**
 * Start a Driver in the Loop drive: create the variation the human will drive.
 *
 * The variation is created before the drive rather than after it, so the drive
 * has a document to write its recorded clip into and a refusal — an unpinned
 * scenario, no drivable vehicle, an ambiguous ego — is a 409 the button can
 * explain instead of a dead drive screen.
 */
export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = DriverInTheLoopSchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_driver_in_the_loop", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;

  // The variation lands in its parent's dataset, so one access check covers both
  // the read of the base scenario and the write of the child.
  const source = await requireScenarioMutableDocumentContext(auth.context, documentId, "copy");
  if (source.response) return source.response;
  const target = await requireScenarioMutableContext(
    auth.context,
    source.access.datasetId,
    "mutateContent",
  );
  if (target.response) return target.response;

  const base = await getScenarioDocument(auth.context, documentId);
  if (!base) return NextResponse.json({ error: "document_not_found" }, { status: 404 });

  const role = resolveDriverRole(base.content, parsed.data.roleId);
  if (!role.ok) {
    return NextResponse.json({ error: "not_drivable", message: role.reason }, { status: 409 });
  }

  const siblings = await listScenarioDocuments(auth.context, 200, base.datasetId);
  const result = await duplicateScenarioDocument(auth.context, documentId, {
    derivation: "variation",
    title: driverInTheLoopTitle(base.title, siblings.map((sibling) => sibling.title)),
    content: driverInTheLoopContent(base.content, role.roleId),
  });
  return result.kind === "created"
    ? NextResponse.json({ document: result.document, roleId: role.roleId }, { status: 201 })
    : NextResponse.json({ error: "document_not_found" }, { status: 404 });
}
