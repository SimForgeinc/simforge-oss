import { NextResponse } from "next/server";
import {
  reclaimCache,
  ReclaimRequestSchema,
} from "@simforge-oss/model-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

/**
 * Report — and optionally reclaim — space in the shared Hugging Face blob
 * cache.
 *
 * The cache is shared with upstream tooling so that a `snapshot_download` and
 * our installer do not each keep their own 22 GB copy. That sharing is
 * exactly why every candidate entry is returned with the list of installs
 * that reference it, and why `dryRun` defaults to true: deleting a blob some
 * other family still needs would silently turn a working install into a
 * failing one.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const parsed = ReclaimRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_reclaim_request" }, { status: 400 });
  }
  const dryRun = parsed.data.dryRun ?? true;
  return NextResponse.json({ dryRun, ...(await reclaimCache({ dryRun })) });
}
