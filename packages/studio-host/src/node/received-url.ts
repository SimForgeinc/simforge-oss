/**
 * The URL a request actually arrived on, as the client spelled it.
 *
 * `request.url` is the *server's* view: Next normalizes the authority to the
 * interface the server bound (and to `localhost` for loopback names), so a
 * host bound to `0.0.0.0` reports `http://localhost:<port>` no matter which
 * address the client reached. Anything the host hands back to a client — a
 * bootstrap URL, a redirect `Location` — must use the authority the client
 * used, or a caller on another machine receives a URL only the host can
 * resolve. The same authority is what an origin check must compare against.
 *
 * `Host` is the authority (a reverse proxy must pass it through unchanged);
 * `X-Forwarded-Proto` is the scheme when a TLS terminator sits in front.
 * Both are client-controlled when nothing sits in front, which is why they
 * are used only to *describe* the caller's own view of this service and never
 * to decide whether a caller is authorized.
 */
export function receivedUrl(request: Request): URL {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) {
    url.host = host;
    // The `host` setter keeps the previous port when the value carries none,
    // which would graft the bound port onto a proxied name.
    if (!/:\d+$/.test(host)) url.port = "";
  }
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  if (forwarded === "http" || forwarded === "https") url.protocol = `${forwarded}:`;
  return url;
}
