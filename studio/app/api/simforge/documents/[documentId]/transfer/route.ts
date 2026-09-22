import { NextResponse } from "next/server";
import { TransferScenarioDocumentSchema } from "@/app/lib/scenario/contracts";
import {
  createCrossMapScenarioDocument,
  getScenarioDocument,
} from "@/app/lib/scenario/document-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutableDocumentContext,
} from "@/app/lib/scenario/http";
import { prepareTransfer } from "../transfer-shared";

type Context = { params: Promise<{ documentId: string }> };

export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = TransferScenarioDocumentSchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_transfer", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { documentId } = await route.params;

  const sourceAccess = await requireScenarioMutableDocumentContext(auth.context, documentId, "copy");
  if (sourceAccess.response) return sourceAccess.response;
  const targetAccess = await requireScenarioMutableContext(
    auth.context,
    sourceAccess.access.datasetId,
    "mutateContent",
  );
  if (targetAccess.response) return targetAccess.response;

  const source = await getScenarioDocument(auth.context, documentId);
  if (!source) return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  try {
    const prepared = await prepareTransfer(auth.context, source, parsed.data);
    if (prepared.kind === "refused") {
      return NextResponse.json({ error: "transfer_refused", message: prepared.message }, { status: 422 });
    }
    const result = await createCrossMapScenarioDocument(auth.context, documentId, {
      title: parsed.data.title,
      targetMapVersionId: parsed.data.targetMapVersionId,
      content: prepared.content,
      receipt: prepared.receipt,
    });
    return result.kind === "created"
      ? NextResponse.json(result.document, { status: 201 })
      : NextResponse.json({ error: "document_not_found" }, { status: 404 });
  } catch (error) {
    console.error(`[transfer] ${documentId} -> ${parsed.data.targetMapVersionId}/${parsed.data.siteId} failed`, error);
    return NextResponse.json(
      { error: "transfer_failed", message: "The variation could not be created. Try again." },
      { status: 500 },
    );
  }
}
