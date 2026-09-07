import { NextResponse } from "next/server";
import {
  InstallConflict,
  LicenseAcceptanceRequired,
  TokenRequired,
  startInstall,
  InstallRequestSchema,
} from "@simforge-oss/model-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

/**
 * Begin (or resume) an install. Returns 202 as soon as the job is registered;
 * the transfer runs in the host process and is observed through
 * `GET /api/models/store/state`.
 *
 * The refusals here are the interesting part, and each one is typed so the UI
 * can explain it before any bytes move rather than after 20 GB:
 *  - `hf_token_required`         a gated sidecar needs an accepted licence and
 *                                a token, and none is in the vault
 *  - `license_acceptance_required` the weights or sidecar licence has not been
 *                                shown and accepted
 *  - `install_in_progress`       one install per family at a time
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const parsed = InstallRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_install_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const state = await startInstall(parsed.data);
    return NextResponse.json(
      { family: parsed.data.family, quant: parsed.data.quant, state },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof TokenRequired) {
      return NextResponse.json({ error: error.code, detail: error.detail }, { status: 400 });
    }
    if (error instanceof LicenseAcceptanceRequired) {
      return NextResponse.json({ error: error.code, detail: error.detail }, { status: 400 });
    }
    if (error instanceof InstallConflict) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    return NextResponse.json(
      { error: "install_failed", message: (error as Error).message },
      { status: 500 },
    );
  }
}
