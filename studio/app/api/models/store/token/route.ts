import { NextResponse } from "next/server";
import {
  clearHfToken,
  storeHfToken,
  vaultStatus,
  TokenRequestSchema,
} from "@simforge-oss/model-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

/**
 * The Hugging Face access token for gated sidecar repositories.
 *
 * Only Alpamayo 1.5 needs one, and only for `nvidia/Cosmos-Reason2-8B`'s
 * configuration and tokenizer — a few files of text, no weights. The value
 * goes straight into this computer's credential vault (the same vault the
 * cloud sign-in uses, with no plaintext fallback) and the response carries
 * only the Hugging Face account NAME. No route ever returns the token, and it
 * is never written to the install record, a log, or a job payload.
 */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(await vaultStatus());
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const parsed = TokenRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_token_request" }, { status: 400 });
  }
  const stored = await storeHfToken(parsed.data.token);
  if (!stored.name) {
    // A token the Hub does not recognise would fail later, mid-install, with
    // a 401 on a gated file. Rejecting it here is the cheaper failure.
    await clearHfToken();
    return NextResponse.json(
      {
        error: "token_rejected",
        detail: { message: "Hugging Face did not recognise this access token" },
      },
      { status: 400 },
    );
  }
  return NextResponse.json({ ...(await vaultStatus()), identity: stored.name });
}

export async function DELETE(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json({ removed: await clearHfToken(), ...(await vaultStatus()) });
}
