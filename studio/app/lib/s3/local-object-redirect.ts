import { NextResponse } from "next/server";
import { MEDIA_URL_TTL_SECONDS } from "./s3-presign";

/**
 * Margin between a presigned URL's lifetime and how long a browser may reuse
 * the redirect that points at it. Reusing a redirect whose signature has since
 * expired costs a failed fetch and a reload; ten minutes is longer than any
 * page load that could be holding one.
 */
const REDIRECT_REUSE_MARGIN_SECONDS = 10 * 60;

/**
 * How long a browser may reuse the redirect itself.
 *
 * A map closure is thousands of members, and each one costs an authorized hop
 * through this app before the object store is reached. Answering `no-store`
 * made every reload pay all of them again — minutes of latency for bytes the
 * browser already had. The redirect is cached for just under the signature's
 * life instead.
 *
 * `private` is the boundary that matters: the redirect names a signed URL
 * issued to one session, so a shared cache must never hold it. Nothing about
 * that changes per environment, which is why this no longer asks which one it
 * is running in.
 */
export function browserAssetRedirectCacheControl() {
  return `private, max-age=${MEDIA_URL_TTL_SECONDS - REDIRECT_REUSE_MARGIN_SECONDS}`;
}

/**
 * Redirect to an object.
 *
 * `url` is whatever the object store handed back: an absolute presigned URL
 * from real storage, or the root-relative reference the local-objects fallback
 * signs (`local-object-auth.ts` explains why it is relative). A relative
 * `Location` is valid per RFC 7231 and the browser resolves it against the
 * origin the request arrived on, which is the only origin that is correct for
 * every way this host can be reached.
 *
 * `NextResponse.redirect` rejects relative URLs, so the header is set directly.
 */
export function objectRedirect(url: string, status: 302 | 307): NextResponse {
  return new NextResponse(null, { status, headers: { Location: url } });
}
