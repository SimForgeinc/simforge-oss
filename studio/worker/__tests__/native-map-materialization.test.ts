import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

import { downloadInputs } from "../http-client";
import { materializeMapClosure } from "../native-render";
import type { NativeMapMember, NativeMapMemberSource, RemoteInput } from "../types";

/**
 * The worker's half of the remote map contract: it is handed one
 * checksum-bound URL per declared closure member and must produce the
 * closure under its own scratch root, reusing what it already downloaded.
 */

const MASTER = Buffer.from("{\"asset\":{\"version\":\"2.0\"}}");
const GEOMETRY = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

const DECLARED: NativeMapMember[] = [
  { inputId: "map.tile.000000", relativePath: "master.gltf", sha256: digest(MASTER), sizeBytes: MASTER.byteLength },
  { inputId: "map.resource.geometry", relativePath: "buffers/geometry.bin", sha256: digest(GEOMETRY), sizeBytes: GEOMETRY.byteLength },
];

const BODIES: Record<string, Buffer> = { "/master.gltf": MASTER, "/buffers/geometry.bin": GEOMETRY };

let server: Server;
let origin: string;
let served: string[] = [];
/** When set, the host answers with these bytes instead of the declared ones. */
let tamper: Buffer | null = null;
let roots: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `simforge-${prefix}-`));
  roots.push(directory);
  return directory;
}

function sources(): NativeMapMemberSource[] {
  return DECLARED.map((member) => ({
    ...member,
    download: { url: `${origin}/${member.relativePath}`, headers: {} },
  }));
}

const silentProgress = async () => {};

before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://host.invalid").pathname;
    served.push(path);
    const body = tamper ?? BODIES[path];
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.byteLength) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  served = [];
  tamper = null;
});

describe("native map closure materialization", () => {
  it("downloads what the cache lacks and reuses what it holds", async () => {
    const workspace = await scratch("map-workspace");
    const cacheRoot = await scratch("map-cache");
    const hit = DECLARED[0]!;
    await mkdir(join(cacheRoot, "sha256", hit.sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(cacheRoot, "sha256", hit.sha256.slice(0, 2), hit.sha256), MASTER);

    const reports: Array<{ completed: number; total: number; unit: string }> = [];
    await materializeMapClosure({
      members: DECLARED,
      sources: sources(),
      directory: join(workspace, "map"),
      cacheRoot,
      hostOrigin: origin,
      signal: AbortSignal.timeout(30_000),
      progress: async (record) => {
        reports.push({ completed: record.completed, total: record.total, unit: record.unit });
      },
    });

    assert.deepEqual(served, ["/buffers/geometry.bin"], "the cached member must not be fetched again");
    assert.deepEqual(await readFile(join(workspace, "map", "master.gltf")), MASTER);
    assert.deepEqual(await readFile(join(workspace, "map", "buffers", "geometry.bin")), GEOMETRY);
    const cached = await stat(join(cacheRoot, "sha256", DECLARED[1]!.sha256.slice(0, 2), DECLARED[1]!.sha256));
    assert.equal(cached.size, GEOMETRY.byteLength, "the downloaded member is published into the cache");
    const last = reports.at(-1);
    assert.equal(last?.unit, "bytes");
    assert.equal(last?.completed, MASTER.byteLength + GEOMETRY.byteLength);

    // A second attempt on the same map is served entirely from the cache.
    const second = await scratch("map-workspace-2");
    served = [];
    await materializeMapClosure({
      members: DECLARED,
      sources: sources(),
      directory: join(second, "map"),
      cacheRoot,
      hostOrigin: origin,
      signal: AbortSignal.timeout(30_000),
      progress: silentProgress,
    });
    assert.deepEqual(served, []);
  });

  it("refuses bytes that are not the declared digest and caches nothing", async () => {
    const workspace = await scratch("map-workspace-bad");
    const cacheRoot = await scratch("map-cache-bad");
    tamper = Buffer.from("not the declared closure");

    await assert.rejects(
      materializeMapClosure({
        members: DECLARED,
        sources: sources(),
        directory: join(workspace, "map"),
        cacheRoot,
        hostOrigin: origin,
        signal: AbortSignal.timeout(30_000),
        progress: silentProgress,
      }),
      /integrity mismatch/,
    );
    for (const member of DECLARED) {
      assert.equal(
        await stat(join(cacheRoot, "sha256", member.sha256.slice(0, 2), member.sha256)).catch(() => null),
        null,
        `${member.inputId} must not be published into the cache`,
      );
    }
  });

  it("refuses a declared member the preparation does not offer", async () => {
    const workspace = await scratch("map-workspace-missing");
    const cacheRoot = await scratch("map-cache-missing");
    await assert.rejects(
      materializeMapClosure({
        members: DECLARED,
        sources: sources().slice(0, 1),
        directory: join(workspace, "map"),
        cacheRoot,
        hostOrigin: origin,
        signal: AbortSignal.timeout(30_000),
        progress: silentProgress,
      }),
      /offers no download for member map\.resource\.geometry/,
    );
    assert.deepEqual(served, [], "nothing is fetched for a closure the host cannot complete");
  });
});

describe("file: inputs", () => {
  async function fileInput(): Promise<RemoteInput> {
    const source = await scratch("closure");
    const path = join(source, "closure.json");
    await writeFile(path, MASTER);
    return {
      inputId: "actors.native-closure",
      relativePath: "actor-assets/closure.json",
      sha256: digest(MASTER),
      sizeBytes: MASTER.byteLength,
      download: { url: pathToFileURL(path).href, headers: {} },
    };
  }

  it("are refused by a worker that claimed from a remote host", async () => {
    const input = await fileInput();
    const workspace = await scratch("inputs-remote");
    await assert.rejects(
      downloadInputs([input], join(workspace, "inputs"), AbortSignal.timeout(30_000), "http://198.51.100.7:5199"),
      /actors\.native-closure is a file: URL/,
    );
  });

  it("are read by a worker co-located with the host", async () => {
    const input = await fileInput();
    const workspace = await scratch("inputs-local");
    const materialized = await downloadInputs([input], join(workspace, "inputs"), AbortSignal.timeout(30_000), origin);
    const file = materialized.get("actors.native-closure");
    assert.ok(file);
    assert.deepEqual(await readFile(file.path), MASTER);
  });
});
