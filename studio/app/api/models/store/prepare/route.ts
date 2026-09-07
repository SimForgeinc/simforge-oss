import { NextResponse } from "next/server";
import {
  InstallRequestSchema,
  PrepareError,
  prepareRuntime,
  readRuntimeRecord,
} from "@simforge-oss/model-store";
import { isModelFamilyId, MODEL_FAMILIES } from "@simforge-oss/model-store/catalog";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/**
 * Provision (or report) the isolated Python runtime for an installed family.
 *
 * Separate from install because the two fail independently and mean different
 * things: a user who only runs models in the cloud never needs a local torch
 * environment, and a failed environment build must not discard 22-72 GB of
 * verified weights.
 *
 * Synchronous: unlike a download this is minutes of dependency resolution
 * with no resumable state worth modelling, and the client already polls
 * install state for the long-running half.
 */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const family = new URL(request.url).searchParams.get("family");
  if (!family || !isModelFamilyId(family)) {
    return NextResponse.json(
      { error: "unknown_family", detail: { family, expected: MODEL_FAMILIES } },
      { status: 400 },
    );
  }
  const record = await readRuntimeRecord(family);
  return NextResponse.json(
    { family, prepared: record !== null, runtime: record },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  // Reuses the install body shape minus the token/licence fields, which a
  // runtime build does not need: the licence was accepted to obtain the
  // weights this environment is being built for.
  const parsed = InstallRequestSchema.pick({ family: true, quant: true }).safeParse(
    await readJson(request),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_prepare_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const record = await prepareRuntime({
      family: parsed.data.family,
      quant: parsed.data.quant,
    });
    return NextResponse.json(record);
  } catch (error) {
    if (error instanceof PrepareError) {
      const status = error.code === "not_installed" || error.code === "unsupported_platform" ? 409 : 500;
      return NextResponse.json(
        { error: error.code, step: error.step, message: error.message, detail: error.detail },
        { status },
      );
    }
    return NextResponse.json(
      { error: "prepare_failed", message: (error as Error).message },
      { status: 500 },
    );
  }
}
