import { NextResponse } from "next/server";
import { LOCAL_HOST_TOKEN_ENV, secretsEqual } from "@simforge-oss/studio-host/node";
import { createPairingStore, formatPairingCode, PAIRING_CODE_LIFETIME_MS } from "@/app/lib/host/pairing";

const NO_STORE = { "cache-control": "no-store" };
const pairing = createPairingStore();

/**
 * Pairing a desktop shell with this host, in two halves of one route:
 *
 *   - with the control token as bearer (`simforge host pair` on the host
 *     machine): mint a short-lived, one-use pairing code;
 *   - without credentials, with `{ code }`: exchange a live code for the
 *     control token, once.
 *
 * The route is exempt from the access gate (`studio/proxy.ts`) because the
 * claiming half has no credentials yet; it verifies the bearer itself for the
 * minting half, exactly as `/api/simforge/host/session` does for tickets.
 * The token only ever travels in a response body, never in a URL, browser
 * history or referrer. Whether that body crosses the network in cleartext is
 * the shell's decision, taken before it claims (the plaintext acknowledgement).
 */
export async function POST(request: Request) {
  const controlToken = process.env[LOCAL_HOST_TOKEN_ENV];
  if (!controlToken) {
    return NextResponse.json({ error: "host_unsupervised" }, { status: 503, headers: NO_STORE });
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer !== undefined) {
    if (!secretsEqual(bearer, controlToken)) {
      return NextResponse.json({ error: "host_control_unauthorized" }, { status: 401, headers: NO_STORE });
    }
    const minted = pairing.mint();
    if (!minted) return NextResponse.json({ error: "pairing_codes_outstanding" }, { status: 429, headers: NO_STORE });
    return NextResponse.json(
      { code: formatPairingCode(minted.code), expiresAt: new Date(minted.expiresAt).toISOString(), lifetimeSeconds: PAIRING_CODE_LIFETIME_MS / 1000 },
      { headers: NO_STORE },
    );
  }
  const body: unknown = await request.json().catch(() => null);
  const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "";
  if (!code || !pairing.claim(code)) {
    return NextResponse.json({ error: "pairing_code_invalid" }, { status: 401, headers: NO_STORE });
  }
  return NextResponse.json({ controlToken }, { headers: NO_STORE });
}
