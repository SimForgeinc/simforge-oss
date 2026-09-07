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

export async function signLocalObjectUrl(url: URL, method: "GET" | "PUT", expiresIn: number): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || !Number.isSafeInteger(expires)) {
    throw new Error("Invalid local object URL lifetime.");
  }
  url.searchParams.set(EXPIRY, String(expires));
  url.searchParams.set(SIGNATURE, createHmac("sha256", await signingKey()).update(payload(url, method)).digest("hex"));
  return url.toString();
}

/** Grants exactly one method/path/query until expiry, never general host access. */
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
