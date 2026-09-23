import { HostOrigin, hostPath } from "@simforge-oss/studio-host";

/**
 * An absolute URL on the Studio host a verification script is driving.
 *
 * Root-relative paths (the API routes a script calls, and the root-relative
 * object URLs a local host signs) are built on the host's origin through
 * `HostOrigin`, the one place absolute host URLs are made
 * (`scripts/verify-origin-urls.mjs`). A value that is already absolute, such
 * as a presigned object-store URL the host handed back, is used as is.
 */
export function hostUrl(base: string | URL, pathOrUrl: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(pathOrUrl)) return new URL(pathOrUrl);
  return HostOrigin.fromConfigured(new URL(base).origin, "dev").toURL(hostPath(pathOrUrl));
}
