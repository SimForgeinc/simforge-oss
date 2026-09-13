import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { FIXTURES_DIR } from "./paths";

/**
 * A deterministic origin for anything the product fetches over HTTP during a
 * test: a map registry, a model service, a download origin. Payloads come from
 * `e2e/fixtures/**` or from explicit route handlers; every response carries a
 * content-hash ETag and a fixed `Last-Modified`, so repeating a flow produces
 * byte-identical traffic.
 */
export type FixtureResponse = {
  status?: number;
  headers?: Record<string, string>;
  /** A string/Buffer body, or any JSON-serialisable value (sent as `application/json`). */
  body?: string | Buffer | unknown;
};

export type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Record<string, string>;
  readonly body: string;
};

export type FixtureRoute = FixtureResponse | ((request: RecordedRequest) => FixtureResponse | Promise<FixtureResponse>);

export type FixtureServer = {
  readonly origin: string;
  /** Absolute URL for a path on this server. */
  url(path: string): string;
  /** Every request this server answered, in order. */
  readonly requests: RecordedRequest[];
  /** Install or replace a route at an exact path (`/v1/maps/index.json`). */
  setRoute(path: string, route: FixtureRoute): void;
  stop(): Promise<void>;
};

export type StartFixtureServerOptions = {
  /** Static payload root; defaults to `e2e/fixtures`. */
  root?: string;
  routes?: Record<string, FixtureRoute>;
  /** Artificial delay before answering, for timeout and cancellation coverage. */
  latencyMs?: number;
};

/** Fixed so repeated runs of a deterministic flow produce identical headers. */
const FIXTURE_LAST_MODIFIED = new Date("2024-01-01T00:00:00.000Z").toUTCString();

function encodeBody(body: FixtureResponse["body"]): { buffer: Buffer; contentType: string } {
  if (body === undefined) return { buffer: Buffer.alloc(0), contentType: "application/octet-stream" };
  if (Buffer.isBuffer(body)) return { buffer: body, contentType: "application/octet-stream" };
  if (typeof body === "string") return { buffer: Buffer.from(body, "utf8"), contentType: "text/plain; charset=utf-8" };
  return { buffer: Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8"), contentType: "application/json" };
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".gz": "application/gzip",
  ".glb": "model/gltf-binary",
  ".xodr": "application/xml",
  ".xosc": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

export async function startFixtureServer(options: StartFixtureServerOptions = {}): Promise<FixtureServer> {
  const root = resolve(options.root ?? FIXTURES_DIR);
  const routes = new Map<string, FixtureRoute>(Object.entries(options.routes ?? {}));
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      void (async () => {
        const url = new URL(incoming.url ?? "/", "http://fixture.invalid");
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers[name] = value;
          else if (Array.isArray(value)) headers[name] = value.join(", ");
        }
        const record: RecordedRequest = {
          method: incoming.method ?? "GET",
          path: url.pathname,
          search: url.search,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        requests.push(record);
        if (options.latencyMs) await new Promise<void>((done) => setTimeout(done, options.latencyMs));

        const route = routes.get(url.pathname);
        let response: FixtureResponse;
        if (route !== undefined) {
          response = typeof route === "function" ? await route(record) : route;
        } else {
          // Static payload: the path must stay inside the fixture root.
          const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
          const file = join(root, relative);
          if (isAbsolute(relative) || !(file === root || file.startsWith(root + sep))) {
            response = { status: 403, body: { error: "fixture_path_rejected", path: url.pathname } };
          } else {
            try {
              const extension = file.slice(file.lastIndexOf("."));
              response = {
                status: 200,
                headers: { "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream" },
                body: await readFile(file),
              };
            } catch {
              response = { status: 404, body: { error: "fixture_not_found", path: url.pathname } };
            }
          }
        }
        const { buffer, contentType } = encodeBody(response.body);
        outgoing.writeHead(response.status ?? 200, {
          "content-type": contentType,
          "content-length": String(buffer.byteLength),
          etag: `"${createHash("sha256").update(buffer).digest("hex").slice(0, 32)}"`,
          "last-modified": FIXTURE_LAST_MODIFIED,
          "cache-control": "no-store",
          ...response.headers,
        });
        outgoing.end(record.method === "HEAD" ? undefined : buffer);
      })();
    });
  });

  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => ready());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fixture server did not bind a port");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    url: (path) => new URL(path, origin).href,
    requests,
    setRoute(path, route) {
      routes.set(path, route);
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
