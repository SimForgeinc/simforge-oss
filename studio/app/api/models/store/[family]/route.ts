import { NextResponse } from "next/server";
import { installRecord, installState, uninstall, type ModelFamilyId } from "@simforge-oss/model-store";
import { MODEL_CATALOG, MODEL_FAMILIES } from "@simforge-oss/model-store/catalog";
import {
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ family: string }> };

async function resolveFamily(context: Context): Promise<ModelFamilyId | null> {
  const { family } = await context.params;
  return (MODEL_FAMILIES as readonly string[]).includes(family) ? (family as ModelFamilyId) : null;
}

/** Catalog entry, live install state and the redacted install record. */
export async function GET(_request: Request, context: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const family = await resolveFamily(context);
  if (!family) return NextResponse.json({ error: "unknown_family" }, { status: 404 });

  const record = await installRecord(family);
  return NextResponse.json(
    {
      family,
      catalog: MODEL_CATALOG[family],
      state: await installState(family),
      // The record contains no secret by construction — the token is in the
      // OS vault and only the account name is recorded — so it is returned
      // as-is rather than filtered, which would imply the filter is what
      // keeps it safe.
      install: record,
    },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

/**
 * Remove an install.
 *
 * `?purgeSharedCache=true` additionally drops this repository's entries from
 * the shared Hugging Face blob cache. It is off by default because that cache
 * is shared with upstream tooling and with the other families.
 *
 * Registry rows that reference the removed version and already have runs are
 * retired rather than deleted: the run ledger is append-only, and a result
 * must keep naming the checkpoint that produced it even after the bytes are
 * gone from this machine.
 */
export async function DELETE(request: Request, context: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const family = await resolveFamily(context);
  if (!family) return NextResponse.json({ error: "unknown_family" }, { status: 404 });

  const purgeSharedCache = new URL(request.url).searchParams.get("purgeSharedCache") === "true";
  const result = await uninstall(family, { purgeSharedCache });
  return NextResponse.json({
    family,
    purgeSharedCache,
    ...result,
    state: await installState(family),
  });
}
