/**
 * The two authorities Studio talks to, as values that cannot be confused.
 *
 * A *host origin* is the private authority where this installation's Studio
 * pages and `/api/**` live: loopback for a local shell, a tailnet or LAN
 * address for a remote host, whatever `Host` a reverse proxy passed through.
 * It is per launch, and for a request it is knowable only from the request.
 *
 * A *cloud origin* is the public, configured SimCloud service. It is stable
 * for a credential and is never derived from a request.
 *
 * Both used to be `string`, which is how a Studio route ended up handing a
 * browser `http://127.0.0.1:<port>` and how a developer daemon could contact
 * production by default. The classes below have private constructors, no
 * public string field and disjoint path types, so a value exists only after
 * validation at a process or request boundary and cannot cross to the other
 * side. `toURL` is the only way to build an absolute URL against either;
 * `scripts/verify-origin-urls.mjs` fails CI on `new URL(path, base)` written
 * anywhere else.
 */

export type HostPath = { readonly kind: "host-path"; readonly value: `/${string}` };
export type CloudPath = { readonly kind: "cloud-path"; readonly value: `/${string}` };

export type OriginMode = "dev" | "packaged";

export type InvalidOriginCode =
  | "host_origin_invalid"
  | "host_origin_plaintext_network"
  | "cloud_origin_invalid"
  | "cloud_origin_insecure"
  | "invalid_path";

export class InvalidOriginError extends Error {
  constructor(readonly code: InvalidOriginCode, message: string) {
    super(message);
    this.name = "InvalidOriginError";
  }
}

const LOOPBACK_HOSTNAMES: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };
/** `Host` as a browser or proxy spells it: a name or IPv4 literal, or a bracketed IPv6 literal, with an optional port. */
const HOST_HEADER = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * Parses a configured value as an exact origin: `http` or `https`, no
 * userinfo, no path beyond `/`, no query, no fragment. Returns the canonical
 * serialization (`URL.origin`), so `https://Example.com:443/` becomes
 * `https://example.com`.
 */
function exactOrigin(value: string, code: InvalidOriginCode, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidOriginError(code, `${label} must be an http:// or https:// origin — got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidOriginError(code, `${label} must be an http:// or https:// origin — got ${value}`);
  }
  if (url.username || url.password) {
    throw new InvalidOriginError(code, `${label} must not carry credentials — got ${value}`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new InvalidOriginError(code, `${label} must be a bare origin with no path, query or fragment — got ${value}`);
  }
  return url;
}

function assertPath(value: string, kind: "host" | "cloud"): asserts value is `/${string}` {
  // A single leading slash: `//other.example/x` is a protocol-relative URL
  // and would resolve to another authority, `\` is treated like `/` by URL.
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    throw new InvalidOriginError("invalid_path", `A ${kind} path must be root-relative — got ${JSON.stringify(value)}`);
  }
}

/** A root-relative path on the Studio host. Rejects protocol-relative and absolute URLs. */
export function hostPath(value: string): HostPath {
  assertPath(value, "host");
  return { kind: "host-path", value };
}

/** A root-relative path on SimCloud. Rejects protocol-relative and absolute URLs. */
export function cloudPath(value: string): CloudPath {
  assertPath(value, "cloud");
  return { kind: "cloud-path", value };
}

function originOf(url: string | URL): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class HostOrigin {
  private constructor(private readonly value: string) {}

  /**
   * The authority a request actually arrived on, as the client spelled it.
   *
   * `request.url` is the *server's* view: Next normalizes the authority to
   * the interface the server bound (and to `localhost` for loopback names),
   * so a host bound to `0.0.0.0` reports `http://localhost:<port>` no matter
   * which address the client reached. Anything the host hands back to a
   * client — a bootstrap URL, a redirect `Location` — must use the authority
   * the client used, or a caller on another machine receives a URL only the
   * host can resolve. The same authority is what an origin check compares
   * against.
   *
   * `Host` is the authority (a reverse proxy must pass it through unchanged);
   * `X-Forwarded-Proto` is the scheme when a TLS terminator sits in front.
   * Both are client-controlled when nothing sits in front. That is fine,
   * and it is the whole point: they *describe* the caller's own view of this
   * service so the host can answer in the caller's terms. They NEVER
   * authorize the caller — a request is trusted by its bearer token or
   * session cookie (`studio/proxy.ts`), and nothing here may be read as
   * "the request came from a trusted address". A future check that grants
   * access because `Host` is loopback is wrong: any page on the machine can
   * send that header.
   *
   * Throws `host_origin_invalid` for a `Host` value that is not an authority.
   */
  static fromReceivedRequest(request: Request): HostOrigin {
    const url = new URL(request.url);
    const host = request.headers.get("host")?.trim();
    if (host !== undefined) {
      if (!HOST_HEADER.test(host)) {
        throw new InvalidOriginError("host_origin_invalid", `Host header is not an authority: ${JSON.stringify(host)}`);
      }
      url.host = host;
      // The `host` setter keeps the previous port when the value carries
      // none, which would graft the bound port onto a proxied name.
      if (!/:\d+$/.test(host)) url.port = "";
    }
    const forwarded = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
    if (forwarded === "http" || forwarded === "https") url.protocol = `${forwarded}:`;
    return new HostOrigin(exactOrigin(url.origin, "host_origin_invalid", "Received host authority").origin);
  }

  /**
   * A host authority from configuration: the supervisor's bound URL, a
   * shell's `SIMFORGE_REMOTE_HOST`, a CLI `--origin`.
   *
   * Over plain HTTP the control token and the session cookie are readable
   * by anyone on the path, and either is full access to the host. A
   * packaged shell therefore refuses `http://` on a non-loopback address
   * unless the operator has acknowledged that the link is a private tailnet
   * (`plaintextNetworkAcknowledged`). Development accepts it: the developer
   * pointing at a LAN box is the operator.
   */
  static fromConfigured(
    value: string,
    mode: OriginMode,
    options: { plaintextNetworkAcknowledged?: boolean } = {},
  ): HostOrigin {
    const url = exactOrigin(value, "host_origin_invalid", "Studio host origin");
    if (mode === "packaged" && url.protocol === "http:" && !LOOPBACK_HOSTNAMES[url.hostname] && !options.plaintextNetworkAcknowledged) {
      throw new InvalidOriginError(
        "host_origin_plaintext_network",
        `${url.origin} is plain HTTP on a network address; the control token and session cookie would cross the network in the clear. Put the host behind HTTPS or reach it over a private tailnet and acknowledge that explicitly.`,
      );
    }
    return new HostOrigin(url.origin);
  }

  toURL(path: HostPath): URL {
    return new URL(path.value, this.value);
  }

  /**
   * The canonical root-relative form of `path` on this host: dot segments
   * resolved, characters percent-encoded, query and fragment kept. The
   * result is what a browser payload or a redirect target should carry, so
   * the client resolves it against the authority it is already using.
   */
  relative(path: HostPath): HostPath {
    const url = this.toURL(path);
    if (url.origin !== this.value) {
      // `hostPath` rejects protocol-relative input; this guards the class
      // invariant against any future loosening of that check.
      throw new InvalidOriginError("invalid_path", `${path.value} does not resolve on ${this.value}`);
    }
    return { kind: "host-path", value: `${url.pathname}${url.search}${url.hash}` as `/${string}` };
  }

  /** True when `url` parses and its origin is exactly this host. `Origin` header values, navigation targets, sender frames. */
  owns(url: string | URL): boolean {
    return originOf(url) === this.value;
  }

  equals(other: HostOrigin): boolean {
    return this.value === other.value;
  }

  isSecure(): boolean {
    return this.value.startsWith("https:");
  }

  /** The `url` a session cookie is scoped to (`session.cookies.set`). The one string form; not for building URLs. */
  hrefForCookie(): string {
    return this.value;
  }
}

export class CloudOrigin {
  private constructor(private readonly value: string) {}

  /**
   * SimCloud from explicit configuration. Packaged builds accept only an
   * exact HTTPS origin. Development additionally accepts literal loopback
   * HTTP, for qualification against a Cloud running on this machine.
   * Anything else is an error, never a fallback.
   */
  static fromConfigured(value: string, mode: OriginMode): CloudOrigin {
    const url = exactOrigin(value, "cloud_origin_invalid", "Cloud origin");
    if (url.protocol !== "https:" && !(mode === "dev" && LOOPBACK_HOSTNAMES[url.hostname])) {
      throw new InvalidOriginError("cloud_origin_insecure", `Cloud origin must be an https origin — got ${value}`);
    }
    return new CloudOrigin(url.origin);
  }

  /**
   * SimCloud from `SIMFORGE_CLOUD_ORIGIN`, or `null` when it is unset or
   * blank. There is no default: an unconfigured Studio has no Cloud to talk
   * to and Cloud operations fail closed as `cloud_not_configured`. A
   * developer daemon must never contact production because nobody set a
   * variable, and a packaged build carries its origin as package metadata
   * validated at startup, not as a compiled-in fallback.
   */
  static fromEnvironment(env: Record<string, string | undefined>, mode: OriginMode): CloudOrigin | null {
    const configured = env.SIMFORGE_CLOUD_ORIGIN?.trim();
    if (!configured) return null;
    return CloudOrigin.fromConfigured(configured, mode);
  }

  toURL(path: CloudPath): URL {
    return new URL(path.value, this.value);
  }

  /** True when `url` parses and its origin is exactly this Cloud. */
  owns(url: string | URL): boolean {
    return originOf(url) === this.value;
  }

  equals(other: CloudOrigin): boolean {
    return this.value === other.value;
  }

  /** The account key a credential is stored under in the OS vault. The one string form; not for building URLs. */
  hrefForVault(): string {
    return this.value;
  }
}
