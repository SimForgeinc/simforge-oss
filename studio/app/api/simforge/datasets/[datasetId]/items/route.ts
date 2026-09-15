import { NextResponse } from "next/server";
import { CreateScenarioDatasetItemSchema } from "@/app/lib/scenario/contracts";
import { addScenarioDatasetItem } from "@/app/lib/scenario/dataset-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ datasetId: string }> };

export async function POST(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateScenarioDatasetItemSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_dataset_item", details: parsed.error.flatten() }, { status: 400 });
  const { datasetId } = await route.params;
  const access = await requireScenarioMutableContext(auth.context, datasetId, "mutateContent");
  if (access.response) return access.response;
  const created = await addScenarioDatasetItem(auth.context, datasetId, parsed.data);
  return created ? NextResponse.json(created, { status: 201 }) : NextResponse.json({ error: "dataset_revision_or_job_not_found" }, { status: 404 });
}
