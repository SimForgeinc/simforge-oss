import { NextResponse } from "next/server";
const DEV_REDIRECT_CACHE_SECONDS = 50 * 60;

export function browserAssetRedirectCacheControl(nodeEnv = process.env.NODE_ENV) {
  // Development assets are immutable and the redirect target remains valid
  // for one hour. Reusing it for fifty minutes lets the browser reuse the S3
  // response cache without risking an expired signature. Shared environments
  // retain the authenticated no-store boundary.
  return nodeEnv === "development"
    ? `private, max-age=${DEV_REDIRECT_CACHE_SECONDS}`
    : "private, no-store";
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
