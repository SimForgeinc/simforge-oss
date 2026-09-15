import { NextResponse } from "next/server";
import { DriverInTheLoopSchema } from "@/app/lib/scenario/contracts";
import { startDriverInTheLoop } from "@/app/lib/scenario/driver-in-the-loop-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutableDocumentContext,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ documentId: string }> };

/**
 * `POST documents/:id/driver-in-the-loop` — protocol `documents.startDriverInTheLoop`.
 * A refusal is a 409 the button can explain instead of a dead drive screen.
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

  const result = await startDriverInTheLoop(auth.context, documentId, parsed.data.roleId);
  switch (result.kind) {
    case "created":
      return NextResponse.json({ document: result.document, roleId: result.roleId }, { status: 201 });
    case "not_drivable":
      return NextResponse.json({ error: "not_drivable", message: result.reason }, { status: 409 });
    case "not_found":
      return NextResponse.json({ error: "document_not_found" }, { status: 404 });
  }
}
