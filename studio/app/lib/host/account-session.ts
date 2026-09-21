import { isCloudHost, type StudioHostCapabilities } from "@simforge-oss/studio-host";

/** Better Auth's sign-out route, served by hosts whose identity is an account. */
export const SIGN_OUT_PATH = "/api/auth/sign-out";

/**
 * Which account line the app switcher shows.
 *
 * - `cloud-connection`: a local install, where the account is a SimCloud
 *   connection this computer may or may not have. Also the answer while the
 *   host's report is still in flight, because that is what every install had
 *   before this question existed.
 * - `host-account`: the host's identity IS an authenticated session. Offering
 *   to sign in to the host you are signed in to is not an offer, and the
 *   surface it would link to says it does not apply here.
 * - `none`: a cloud host that has not claimed an account. Inventing one would
 *   be a claim about who you are.
 */
export function switcherAccountKind(
  capabilities: StudioHostCapabilities | null,
): "cloud-connection" | "host-account" | "none" {
  if (capabilities === null || !isCloudHost(capabilities)) return "cloud-connection";
  return capabilities.identity.mode === "account" ? "host-account" : "none";
}

/**
 * End the session and leave.
 *
 * A local install has one fixed owner and so has no sign-out; a host whose
 * identity is an account has nothing else. A failed request still leaves the
 * session behind on this client and the landing page is where an
 * unauthenticated visitor belongs, so the navigation happens either way — it
 * is what the person asked for.
 */
export async function signOutOfHost(navigate: (href: string) => void): Promise<void> {
  try {
    // The body is `{}` and not nothing: the route declares JSON, and Better
    // Auth answers an empty body with 400 "Invalid JSON in request body" and
    // leaves the session alive — a sign-out that silently did not sign out.
    await fetch(SIGN_OUT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    // Reported by arriving signed out, or by still being signed in.
  }
  navigate("/");
}
