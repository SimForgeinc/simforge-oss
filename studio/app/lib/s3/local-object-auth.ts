import { createHmac, timingSafeEqual } from "node:crypto";
import { LOCAL_HOST_TOKEN_ENV, readLocalHostState } from "@simforge-oss/studio-host/node";

const SIGNATURE = "_sf_signature";
const EXPIRY = "_sf_expires";

async function signingKey(): Promise<string> {
  const configured = process.env[LOCAL_HOST_TOKEN_ENV];
  if (configured) return configured;
  const host = await readLocalHostState();
  if (!host) throw new Error("Local object URLs require a supervised Studio host.");
  return host.controlToken;
}

function payload(url: URL, method: "GET" | "PUT"): string {
  const query = new URLSearchParams(url.search);
  query.delete(SIGNATURE);
  query.sort();
  // The authority is deliberately not signed: a colocated worker may route
  // the same object endpoint over loopback instead of the host's HTTPS name.
  return `${method}\n${url.pathname}\n${query.toString()}`;
}

/**
 * Grant one method/path/query until expiry, as a ROOT-RELATIVE reference.
 *
 * The authority is not signed (see `payload`), so it is not part of the grant
 * and there is no correct value for the server to invent: this host is reached
 * on a loopback port, a LAN address and a tunnelled HTTPS name at the same
 * time, and any single absolute origin is wrong for the other two. A browser
 * resolves a relative reference against the page it actually loaded, which is
 * right for all of them with no configuration.
 *
 * A non-browser caller resolves it against the base it is already talking to —
 * `studio/worker/http-client.ts` and `packages/studio-host/src/http-client.ts`
 * both already do exactly that. So the failure mode for a missed resolution is
 * a loud throw in a server fetch instead of a silently dead image in every
 * remote browser, which is the way round we want it.
 */
export async function signLocalObjectUrl(url: URL, method: "GET" | "PUT", expiresIn: number): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || !Number.isSafeInteger(expires)) {
    throw new Error("Invalid local object URL lifetime.");
  }
  url.searchParams.set(EXPIRY, String(expires));
  url.searchParams.set(SIGNATURE, createHmac("sha256", await signingKey()).update(payload(url, method)).digest("hex"));
  return `${url.pathname}${url.search}`;
}

export async function verifyLocalObjectRequest(request: Request): Promise<boolean> {
  const method = request.method === "HEAD" ? "GET" : request.method;
  if (method !== "GET" && method !== "PUT") return false;
  const url = new URL(request.url);
  const signature = url.searchParams.get(SIGNATURE);
  const rawExpiry = url.searchParams.get(EXPIRY);
  if (!signature || !/^[a-f0-9]{64}$/.test(signature) || !rawExpiry || !/^\d+$/.test(rawExpiry)) return false;
  const expires = Number(rawExpiry);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", await signingKey()).update(payload(url, method)).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}
