import { NextResponse } from "next/server";
import { TransferScenarioDocumentOptionsSchema } from "@/app/lib/scenario/contracts";
import { getScenarioDocument } from "@/app/lib/scenario/document-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutableDocumentContext,
} from "@/app/lib/scenario/http";
import { transferOptions } from "../transfer-shared";

type Context = { params: Promise<{ documentId: string }> };

export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = TransferScenarioDocumentOptionsSchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_document_transfer_options", details: parsed.error.flatten() },
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
  return NextResponse.json(
    await transferOptions(auth.context, source, parsed.data.targetMapVersionIds),
  );
}
