import { NextResponse } from "next/server";
import {
  verifyInstall,
  VerifyRequestSchema,
} from "@simforge-oss/model-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

/**
 * Re-verify an install against the lock.
 *
 * Default is a size and shard-set check, which is cheap; `deep: true`
 * re-streams every shard and recomputes its digest. The response says which
 * check ran per file, so "verified" never means more than it did.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const parsed = VerifyRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_verify_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const result = await verifyInstall(parsed.data.family, { deep: parsed.data.deep ?? false });
    return NextResponse.json({ family: parsed.data.family, deep: parsed.data.deep ?? false, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: "verify_failed", message: (error as Error).message },
      { status: 500 },
    );
  }
}
