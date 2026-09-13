// Real-map catalog, install and cache behaviour, end to end through the
// shipped `simforge maps` surface.
//
// Two run classes live here and they are never confused with one another:
//
//  * DETERMINISTIC (every PR). A byte-identical compact map closure from
//    `e2e/fixtures/maps/compact-map.json` is published into a throwaway
//    registry tree inside the test's own sandbox and served either as a
//    `file://` origin or through the harness fixture server. Every closure
//    and release digest is therefore fixed and asserted by value, so catalog
//    listing, installation receipts, blob-cache reuse, corruption recovery,
//    cache-root isolation and origin loss are all provable without touching
//    the network or a real corpus.
//
//  * HEAVYWEIGHT REAL MAP (nightly). Exercised only against a genuinely
//    installed corpus named by SIMFORGE_E2E_MAPS_FIXTURE_ROOT. When it is
//    absent the run FAILS with the machine-readable `prerequisite-missing`
//    record the harness emits — it is never downgraded to the fixture map and
//    never substituted with a starter scene. A real-map verdict may only be
//    reported for bytes that really came from the map registry.
//
// The registry tree is written here rather than through
// `@simforge-oss/map-registry` on purpose: that workspace package is not
// linked into the repository root, so the e2e project cannot import it. The
// small canonical-JSON/digest helpers below mirror
// `packages/map-registry/src/schema.ts` exactly; if they ever drift, the
// product code rejects the fixture registry and these tests fail loudly
// rather than silently testing a shape nobody ships.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PREREQUISITES,
  expect,
  linkInstalledMaps,
  requirePrerequisites,
  runCli,
  startFixtureServer,
  test,
  writeEvidence,
  type E2eContext,
} from "../support/index";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "maps");

/** The one public map. Everything else needs an authorized private registry. */
const PUBLIC_MAP = "richmond-field-station";
/** A private-visibility name, used for the access-gating cases. */
const PRIVATE_MAP = "e2e-compact-yard";

// ─── fixture data ────────────────────────────────────────────────────────────

type FixtureFile = { path: string; encoding: "utf8" | "base64"; content: string };
type MapFixture = {
  schema: "simforge.e2e.map-fixture.v1";
  createdAt: string;
  summary: Record<string, unknown>;
  canonical: { files: FixtureFile[] };
  web: { toolFingerprint: string; files: FixtureFile[] };
};

const fixture: MapFixture = JSON.parse(
  await readFile(join(fixtureRoot, "compact-map.json"), "utf8"),
) as MapFixture;

function fixtureBytes(files: readonly FixtureFile[]): Map<string, Buffer> {
  const bytes = new Map<string, Buffer>();
  for (const file of files) {
    bytes.set(file.path, Buffer.from(file.content, file.encoding === "utf8" ? "utf8" : "base64"));
  }
  return bytes;
}

const canonicalFiles = fixtureBytes(fixture.canonical.files);
const webFiles = fixtureBytes(fixture.web.files);

// ─── registry schema mirror (packages/map-registry/src/schema.ts) ────────────

type ClosureMember = { sha256: string; bytes: number };
type MapClosure = {
  schema: "map-closure.v1";
  members: Record<string, ClosureMember>;
  kind: "canonical" | "web";
  toolFingerprint?: string;
  metadata?: { master?: boolean };
};
type MapRelease = {
  schema: "simforge.map-release.v1";
  name: string;
  version: `v${number}`;
  visibility: "private" | "public";
  createdAt: string;
  canonical: { key: string; digest: string };
  web?: { key: string; digest: string };
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const closureDigest = (closure: MapClosure): string => sha256(canonicalJson(closure));
const releaseDigest = (release: MapRelease): string => sha256(canonicalJson(release));
const blobKey = (digest: string): string => `blobs/sha256/${digest.slice(0, 2)}/${digest}`;

function closureOf(files: Map<string, Buffer>, kind: "canonical" | "web", toolFingerprint?: string): MapClosure {
  const members: Record<string, ClosureMember> = {};
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    members[path] = { sha256: sha256(bytes), bytes: bytes.length };
  }
  return kind === "canonical"
    ? { schema: "map-closure.v1", kind, members, metadata: { master: true } }
    : { schema: "map-closure.v1", kind, toolFingerprint: toolFingerprint!, members };
}

const canonicalClosure = closureOf(canonicalFiles, "canonical");
const webClosure = closureOf(webFiles, "web", fixture.web.toolFingerprint);

// Which members each installed profile is expected to materialize; these
// mirror the pull profile filters in packages/map-registry/src/registry.ts.
const allMembers = Object.keys(canonicalClosure.members).sort();
/** dev-assets: the road sidecars, without the master scene or any image. */
const semanticMembers = allMembers.filter(
  (path) => path !== "master.gltf" && path !== "geometry.bin" && !path.startsWith("images/"),
);
/** .corpus: everything except the verbatim source rasters. */
const nativeMembers = allMembers.filter((path) => !/^images\/[^/]+\.(?:png|jpe?g|webp|avif)$/i.test(path));
/** dev-assets with `--archive`: the whole canonical closure. */
const archiveMembers = allMembers;
/** map-bundles: the web tier plus the same semantics the compiler reads. */
const webMembers = [...new Set([...semanticMembers, ...Object.keys(webClosure.members)])].sort();

// ─── a registry the test owns, on disk ───────────────────────────────────────

type FixtureRegistry = {
  /** Filesystem root of the registry tree. */
  root: string;
  /** `file://` URL accepted by `--registry`. */
  url: string;
  name: string;
  version: `v${number}`;
  closureDigest: string;
  releaseDigest: string;
  webDigest: string;
  /** Absolute path of a member's content-addressed object at the origin. */
  blobPath(memberPath: string): string;
};

/**
 * Writes the immutable-release layout `resolveVersion`/`pullVersion` read:
 * `index.json`, `maps/<name>/versions.json`, the canonical and web closures,
 * `release.json`, and one content-addressed object per member.
 *
 * `visibility` defaults to the policy value for the name; overriding it is how
 * the access-gating case forges a private map that claims to be public.
 */
async function publishFixtureMap(
  root: string,
  options: { name: string; visibility?: "private" | "public"; version?: `v${number}` } = { name: PUBLIC_MAP },
): Promise<FixtureRegistry> {
  const name = options.name;
  const version = options.version ?? "v1";
  const canonicalKey = `maps/${name}/${version}/closure.json`;
  const webKey = `maps/${name}/${version}/derived/web-${sha256(fixture.web.toolFingerprint).slice(0, 24)}.json`;
  const release: MapRelease = {
    schema: "simforge.map-release.v1",
    name,
    version,
    visibility: options.visibility ?? (name === PUBLIC_MAP ? "public" : "private"),
    createdAt: fixture.createdAt,
    canonical: { key: canonicalKey, digest: closureDigest(canonicalClosure) },
    web: { key: webKey, digest: closureDigest(webClosure) },
  };
  const record = {
    version,
    closureDigest: release.canonical.digest,
    releaseDigest: releaseDigest(release),
    createdAt: release.createdAt,
  };

  const put = async (key: string, bytes: Uint8Array | string): Promise<void> => {
    const target = join(root, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };

  for (const files of [canonicalFiles, webFiles]) {
    for (const bytes of files.values()) await put(blobKey(sha256(bytes)), bytes);
  }
  await put(canonicalKey, canonicalJson(canonicalClosure));
  await put(webKey, canonicalJson(webClosure));
  await put(`maps/${name}/${version}/release.json`, canonicalJson(release));
  await put(`maps/${name}/versions.json`, canonicalJson([record]));
  await put("index.json", canonicalJson({ [name]: { latest: version, versions: [version], summary: fixture.summary } }));

  return {
    root,
    url: `file://${root}`,
    name,
    version,
    closureDigest: record.closureDigest,
    releaseDigest: record.releaseDigest,
    webDigest: release.web!.digest,
    blobPath(memberPath: string) {
      const member = canonicalClosure.members[memberPath] ?? webClosure.members[memberPath];
      if (member === undefined) throw new Error(`fixture map has no member ${memberPath}`);
      return join(root, blobKey(member.sha256));
    },
  };
}

async function fixtureRegistryFor(
  ctx: E2eContext,
  options: { name: string; visibility?: "private" | "public" } = { name: PUBLIC_MAP },
): Promise<FixtureRegistry> {
  const root = join(ctx.dataRoot, "map-origins", `${options.name}-${options.visibility ?? "policy"}`);
  await mkdir(root, { recursive: true });
  return publishFixtureMap(root, options);
}

// ─── installed-corpus inspection ─────────────────────────────────────────────

type Installation = {
  schema: "simforge.map-installation.v1";
  name: string;
  version: string;
  releaseDigest: string;
  canonicalDigest: string;
  webDigest?: string;
  profile: "semantic" | "native" | "web";
  members: Record<string, ClosureMember>;
};

/**
 * Reads an installation receipt and rejects anything that is not a complete,
 * self-consistent `simforge.map-installation.v1` document. An unreadable,
 * truncated or identity-mismatched receipt is a hard failure here: a corpus
 * whose provenance cannot be stated is not an installed map.
 */
async function readReceipt(profileDir: string, expected: { name: string; profile: Installation["profile"] }): Promise<Installation> {
  const path = join(profileDir, ".map-release.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`invalid receipt: ${path} is unreadable (${(error as Error).message})`);
  }
  let receipt: Installation;
  try {
    receipt = JSON.parse(raw) as Installation;
  } catch (error) {
    throw new Error(`invalid receipt: ${path} is not JSON (${(error as Error).message})`);
  }
  const problems: string[] = [];
  if (receipt.schema !== "simforge.map-installation.v1") problems.push(`schema ${String(receipt.schema)}`);
  if (receipt.name !== expected.name) problems.push(`name ${String(receipt.name)} != ${expected.name}`);
  if (receipt.profile !== expected.profile) problems.push(`profile ${String(receipt.profile)} != ${expected.profile}`);
  if (!/^v[1-9][0-9]*$/.test(String(receipt.version))) problems.push(`version ${String(receipt.version)}`);
  for (const field of ["releaseDigest", "canonicalDigest"] as const) {
    if (!/^[a-f0-9]{64}$/.test(String(receipt[field]))) problems.push(`${field} ${String(receipt[field])}`);
  }
  if (receipt.webDigest !== undefined && !/^[a-f0-9]{64}$/.test(receipt.webDigest)) {
    problems.push(`webDigest ${receipt.webDigest}`);
  }
  if (!receipt.members || typeof receipt.members !== "object") problems.push("members missing");
  if (problems.length > 0) throw new Error(`invalid receipt: ${path} (${problems.join("; ")})`);
  return receipt;
}

/** Every materialized file under an installed profile, receipt excluded. */
async function installedFiles(profileDir: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else found.push(relative(profileDir, path).split("\\").join("/"));
    }
  };
  await visit(profileDir);
  return found.filter((path) => path !== ".map-release.json").sort();
}

const profileDir = (ctx: E2eContext, profile: "dev-assets" | ".corpus" | "map-bundles", name: string): string =>
  join(ctx.mapsCacheRoot, profile, name);

async function digestOfFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

/** `simforge maps list --registry` — the remote catalog document. */
type RegistryCatalog = {
  registry: string;
  maps: Record<string, { latest: string; versions: string[] }>;
};

/** `simforge maps pull` — the install result document. */
type PullPayload = {
  name: string;
  version: string;
  closureDigest: string;
  releaseDigest: string;
  materialized: Record<string, string>;
  nativeWorkerInputs: Array<{ memberPath: string; sha256: string; sizeBytes: number; materializedPath: string }>;
};

/** `simforge maps list` — the locally installed, derived catalog. */
type LocalCatalog = {
  devAssets: string;
  maps: Array<{
    mapId: string;
    artifacts: Record<string, boolean>;
    catalogRevision: string | null;
    matcherIndexDigest: string | null;
    engineGraphDigest: string | null;
    stats: { locations: number; segments: number; junctions: number } | null;
  }>;
};

/** Pull through the shipped CLI, against a registry the test controls. */
async function pull(
  ctx: E2eContext,
  registry: FixtureRegistry,
  options: { cacheRoot?: string; blobCacheRoot?: string; archive?: boolean; expectExit?: number } = {},
) {
  const args = ["maps", "pull", `${registry.name}@${registry.version}`, "--registry", registry.url];
  if (options.cacheRoot !== undefined) args.push("--cache-root", options.cacheRoot);
  if (options.blobCacheRoot !== undefined) args.push("--blob-cache-root", options.blobCacheRoot);
  if (options.archive === true) args.push("--archive");
  return runCli(args, { ctx, ...(options.expectExit === undefined ? {} : { expectExit: options.expectExit }) });
}

// ─── deterministic fixture-origin coverage (runs on every PR) ────────────────

test.describe("maps: deterministic fixture registry", () => {
  test("catalogs the public map over the harness fixture origin", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    const server = await startFixtureServer({ root: registry.root });
    e2e.register(() => server.stop());

    const listed = await runCli(["maps", "list", "--registry", server.origin], { ctx: e2e, expectExit: 0 });
    const catalog = listed.json as RegistryCatalog;
    const index = catalog.maps;

    expect(Object.keys(index)).toEqual([PUBLIC_MAP]);
    expect(index[PUBLIC_MAP]).toMatchObject({ latest: "v1", versions: ["v1"] });
    // The catalog is the public surface: a private map must not be listed by it.
    expect(Object.keys(index)).not.toContain(PRIVATE_MAP);
    expect(server.requests.some((request) => request.path.endsWith("index.json"))).toBe(true);

    await writeEvidence(e2e, "maps-catalog-fixture-origin", {
      mode: "deterministic-fixture",
      origin: server.origin,
      map: PUBLIC_MAP,
      latest: index[PUBLIC_MAP]?.latest,
      digests: { closure: registry.closureDigest, release: registry.releaseDigest, web: registry.webDigest },
    });
  });

  test("installs every profile with verified receipts and stable digests", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    const result = await pull(e2e, registry, { expectExit: 0 });
    const payload = result.json as PullPayload;

    expect(payload.name).toBe(PUBLIC_MAP);
    expect(payload.version).toBe("v1");
    // Digests are a property of the bytes, not of the run: assert by value.
    expect(payload.closureDigest).toBe(registry.closureDigest);
    expect(payload.releaseDigest).toBe(registry.releaseDigest);
    expect(Object.keys(payload.materialized).sort()).toEqual(["canonical", "native", "web"]);

    // Install progress is reported as the complete native input set.
    expect(payload.nativeWorkerInputs.map((input) => input.memberPath).sort()).toEqual(nativeMembers);
    for (const input of payload.nativeWorkerInputs) {
      expect(input.sizeBytes).toBe(canonicalClosure.members[input.memberPath]?.bytes);
      expect(await digestOfFile(input.materializedPath)).toBe(input.sha256);
    }

    const semantic = profileDir(e2e, "dev-assets", PUBLIC_MAP);
    const native = profileDir(e2e, ".corpus", PUBLIC_MAP);
    const web = profileDir(e2e, "map-bundles", PUBLIC_MAP);

    expect(await installedFiles(semantic)).toEqual(semanticMembers);
    expect(await installedFiles(native)).toEqual(nativeMembers);
    expect(await installedFiles(web)).toEqual(webMembers);

    const receipts = {
      semantic: await readReceipt(semantic, { name: PUBLIC_MAP, profile: "semantic" }),
      native: await readReceipt(native, { name: PUBLIC_MAP, profile: "native" }),
      web: await readReceipt(web, { name: PUBLIC_MAP, profile: "web" }),
    };
    for (const receipt of Object.values(receipts)) {
      expect(receipt.releaseDigest).toBe(registry.releaseDigest);
      expect(receipt.canonicalDigest).toBe(registry.closureDigest);
      expect(receipt.webDigest).toBe(registry.webDigest);
    }
    // The receipt names exactly what the profile materialized, nothing else.
    expect(Object.keys(receipts.semantic.members).sort()).toEqual(semanticMembers);
    expect(Object.keys(receipts.native.members).sort()).toEqual(nativeMembers);
    expect(Object.keys(receipts.web.members).sort()).toEqual(webMembers);

    // Installed bytes are the fixture's bytes, member by member.
    for (const memberPath of nativeMembers) {
      expect(await readFile(join(native, ...memberPath.split("/")))).toEqual(canonicalFiles.get(memberPath));
    }
    expect(await readFile(join(web, "3d", "manifest.json"))).toEqual(webFiles.get("3d/manifest.json"));

    await writeEvidence(e2e, "maps-install-fixture", {
      mode: "deterministic-fixture",
      map: PUBLIC_MAP,
      version: payload.version,
      digests: {
        release: payload.releaseDigest,
        canonicalClosure: payload.closureDigest,
        webClosure: registry.webDigest,
      },
      profiles: {
        semantic: { path: semantic, members: semanticMembers.length },
        native: { path: native, members: nativeMembers.length },
        web: { path: web, members: webMembers.length },
      },
    });
  });

  test("archives the verbatim source rasters only when asked", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await pull(e2e, registry, { expectExit: 0 });
    const semantic = profileDir(e2e, "dev-assets", PUBLIC_MAP);
    expect(await installedFiles(semantic)).toEqual(semanticMembers);

    await pull(e2e, registry, { archive: true, expectExit: 0 });
    expect(await installedFiles(semantic)).toEqual(archiveMembers);
    expect(Object.keys((await readReceipt(semantic, { name: PUBLIC_MAP, profile: "semantic" })).members).sort())
      .toEqual(archiveMembers);
  });

  test("reuses the shared blob cache instead of refetching from the origin", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await pull(e2e, registry, { expectExit: 0 });

    // Warm cache, hostile origin: every origin object is replaced with
    // same-length garbage. A pull that still succeeds provably read no bytes
    // from the origin, and the install still matches the real content.
    for (const memberPath of archiveMembers) {
      const path = registry.blobPath(memberPath);
      await writeFile(path, Buffer.alloc(canonicalClosure.members[memberPath]!.bytes, 0x5a));
    }
    await pull(e2e, registry, { expectExit: 0 });

    const native = profileDir(e2e, ".corpus", PUBLIC_MAP);
    expect(await digestOfFile(join(native, "master.gltf"))).toBe(canonicalClosure.members["master.gltf"]!.sha256);
    const receipt = await readReceipt(native, { name: PUBLIC_MAP, profile: "native" });
    expect(receipt.releaseDigest).toBe(registry.releaseDigest);
  });

  test("isolates one cache root from another", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await pull(e2e, registry, { expectExit: 0 });
    const primaryNative = profileDir(e2e, ".corpus", PUBLIC_MAP);
    const primaryDigest = await digestOfFile(join(primaryNative, "master.gltf"));

    // Same content, different cache root: the first root's warm blobs must not
    // be visible, so a corrupted origin is detected instead of silently reused.
    await writeFile(
      registry.blobPath("master.gltf"),
      Buffer.alloc(canonicalClosure.members["master.gltf"]!.bytes, 0x5a),
    );
    const isolated = join(e2e.dataRoot, "isolated-cache");
    const failed = await pull(e2e, registry, { cacheRoot: isolated, expectExit: 1 });
    expect(failed.stderr).toContain("registry blob verification failed");
    expect(await exists(join(isolated, ".corpus", PUBLIC_MAP))).toBe(false);

    // The first cache root is untouched by the second root's failure.
    expect(await digestOfFile(join(primaryNative, "master.gltf"))).toBe(primaryDigest);
    await readReceipt(primaryNative, { name: PUBLIC_MAP, profile: "native" });
  });

  test("resumes a half-installed corpus and reopens with an identical receipt", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await pull(e2e, registry, { expectExit: 0 });
    const native = profileDir(e2e, ".corpus", PUBLIC_MAP);
    const before = await readReceipt(native, { name: PUBLIC_MAP, profile: "native" });

    // Simulate a run killed mid-install: the receipt and part of the payload
    // are gone and a stale in-progress directory is still lying around.
    await rm(join(native, ".map-release.json"));
    await rm(join(native, "geometry.bin"));
    await rm(join(native, "images"), { recursive: true, force: true });
    const stale = `${native}.pull-11111111-2222-3333-4444-555555555555`;
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "master.gltf"), "half-written");

    await pull(e2e, registry, { expectExit: 0 });

    expect(await installedFiles(native)).toEqual(nativeMembers);
    const after = await readReceipt(native, { name: PUBLIC_MAP, profile: "native" });
    // Reopening an immutable release yields the same identity, byte for byte.
    expect(after).toEqual(before);
    expect(await digestOfFile(join(native, "geometry.bin"))).toBe(canonicalClosure.members["geometry.bin"]!.sha256);
    // The abandoned scratch directory never becomes part of the installation.
    expect(await installedFiles(native)).not.toContain("half-written");
  });

  test("repairs a corrupted object in the local blob cache", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await pull(e2e, registry, { expectExit: 0 });

    const digest = canonicalClosure.members["master.gltf"]!.sha256;
    const cached = join(e2e.mapsCacheRoot, ".blobs", "sha256", digest.slice(0, 2), digest);
    expect(await digestOfFile(cached)).toBe(digest);
    await writeFile(cached, Buffer.alloc(canonicalClosure.members["master.gltf"]!.bytes, 0x00));

    await pull(e2e, registry, { expectExit: 0 });

    // The cache entry is re-fetched and repaired, and the install is correct.
    expect(await digestOfFile(cached)).toBe(digest);
    expect(await digestOfFile(join(profileDir(e2e, ".corpus", PUBLIC_MAP), "master.gltf"))).toBe(digest);
  });

  test("fails clearly when an origin object is corrupted", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await writeFile(
      registry.blobPath("geometry.bin"),
      Buffer.alloc(canonicalClosure.members["geometry.bin"]!.bytes, 0xff),
    );

    const failed = await pull(e2e, registry, { expectExit: 1 });
    expect(failed.stderr).toContain("registry blob verification failed");
    expect(failed.stderr).toContain(canonicalClosure.members["geometry.bin"]!.sha256);
    // Nothing half-verified is presented as an installation.
    expect(await exists(profileDir(e2e, ".corpus", PUBLIC_MAP))).toBe(false);

    await writeEvidence(e2e, "maps-corruption-detected", {
      mode: "deterministic-fixture",
      map: PUBLIC_MAP,
      corruptedMember: "geometry.bin",
      expectedDigest: canonicalClosure.members["geometry.bin"]!.sha256,
      outcome: "install-refused",
    });
  });

  test("fails clearly when an origin object is missing", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    await pull(e2e, registry, { expectExit: 0 });
    const native = profileDir(e2e, ".corpus", PUBLIC_MAP);
    const installed = await readReceipt(native, { name: PUBLIC_MAP, profile: "native" });

    await rm(registry.blobPath("map.xodr"));
    const cold = join(e2e.dataRoot, "cold-cache");
    const failed = await pull(e2e, registry, { cacheRoot: cold, expectExit: 1 });
    expect(failed.stderr).toContain("ENOENT");
    expect(await exists(join(cold, ".corpus", PUBLIC_MAP))).toBe(false);

    // The already-installed corpus survives a failed pull elsewhere.
    expect(await readReceipt(native, { name: PUBLIC_MAP, profile: "native" })).toEqual(installed);
  });

  test("rejects a release whose recorded digest no longer matches", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    const releasePath = join(registry.root, "maps", PUBLIC_MAP, "v1", "release.json");
    const tampered = JSON.parse(await readFile(releasePath, "utf8")) as MapRelease;
    tampered.createdAt = "2030-06-06T06:06:06.000Z";
    await writeFile(releasePath, canonicalJson(tampered));

    const failed = await pull(e2e, registry, { expectExit: 1 });
    expect(failed.stderr).toContain("release digest or identity mismatch");
    expect(await exists(profileDir(e2e, ".corpus", PUBLIC_MAP))).toBe(false);
  });

  test("gates private maps on the registry they are published to", async ({ e2e }) => {
    // An authorized private registry, named explicitly, installs normally.
    const authorized = await fixtureRegistryFor(e2e, { name: PRIVATE_MAP });
    const installed = await pull(e2e, authorized, { expectExit: 0 });
    const installedPayload = installed.json as PullPayload;
    expect(installedPayload.name).toBe(PRIVATE_MAP);
    const receipt = await readReceipt(profileDir(e2e, ".corpus", PRIVATE_MAP), {
      name: PRIVATE_MAP,
      profile: "native",
    });
    expect(receipt.releaseDigest).toBe(authorized.releaseDigest);

    // A private map that claims public visibility is refused outright: public
    // visibility is policy, not a field a publisher gets to assert.
    const forged = await fixtureRegistryFor(e2e, { name: PRIVATE_MAP, visibility: "public" });
    const failed = await pull(e2e, forged, { cacheRoot: join(e2e.dataRoot, "forged-cache"), expectExit: 1 });
    expect(failed.stderr).toContain("visibility violates public policy");
    expect(await exists(join(e2e.dataRoot, "forged-cache", ".corpus", PRIVATE_MAP))).toBe(false);

    await writeEvidence(e2e, "maps-private-gating", {
      mode: "deterministic-fixture",
      authorized: { map: PRIVATE_MAP, releaseDigest: authorized.releaseDigest, outcome: "installed" },
      forgedPublicVisibility: { map: PRIVATE_MAP, outcome: "refused" },
    });
  });

  test("survives losing the origin and recovers when it comes back", async ({ e2e }) => {
    const registry = await fixtureRegistryFor(e2e);
    const server = await startFixtureServer({ root: registry.root });
    expect((await runCli(["maps", "list", "--registry", server.origin], { ctx: e2e, expectExit: 0 })).json)
      .toMatchObject({ maps: { [PUBLIC_MAP]: { latest: "v1" } } });

    // Install from the local origin, then take the network origin away.
    await pull(e2e, registry, { expectExit: 0 });
    const native = profileDir(e2e, ".corpus", PUBLIC_MAP);
    const offlineReceipt = await readReceipt(native, { name: PUBLIC_MAP, profile: "native" });
    const offlineOrigin = server.origin;
    await server.stop();

    const offline = await runCli(["maps", "list", "--registry", offlineOrigin], { ctx: e2e, expectExit: 1 });
    expect(offline.stderr.length).toBeGreaterThan(0);
    expect(offline.stdout.trim()).toBe("");
    // An unreachable origin does not invalidate what is already installed.
    expect(await readReceipt(native, { name: PUBLIC_MAP, profile: "native" })).toEqual(offlineReceipt);
    expect(await digestOfFile(join(native, "master.gltf"))).toBe(canonicalClosure.members["master.gltf"]!.sha256);

    // Reconnect: a fresh origin serving the same immutable release resolves to
    // the same identity, and the warm cache makes the re-pull a no-op.
    const reconnected = await startFixtureServer({ root: registry.root });
    e2e.register(() => reconnected.stop());
    const relisted = await runCli(["maps", "list", "--registry", reconnected.origin], { ctx: e2e, expectExit: 0 });
    expect(relisted.json).toMatchObject({ maps: { [PUBLIC_MAP]: { latest: "v1" } } });

    await pull(e2e, registry, { expectExit: 0 });
    expect(await readReceipt(native, { name: PUBLIC_MAP, profile: "native" })).toEqual(offlineReceipt);

    await writeEvidence(e2e, "maps-offline-reconnect", {
      mode: "deterministic-fixture",
      map: PUBLIC_MAP,
      offlineOrigin,
      reconnectedOrigin: reconnected.origin,
      digests: { release: registry.releaseDigest, canonicalClosure: registry.closureDigest },
      corpusIntactWhileOffline: true,
    });
  });
});

// ─── heavyweight real-map coverage (nightly) ─────────────────────────────────

test.describe("maps: real installed corpus", () => {
  test.describe.configure({ timeout: 10 * 60_000 });

  test("qualifies the pinned public real map from the real corpus", async ({ e2e }, testInfo) => {
    // No corpus, no verdict. This throws with the variables to set rather than
    // quietly re-running the synthetic fixture map.
    await requirePrerequisites(testInfo, [PREREQUISITES.realMaps]);

    const linked = await linkInstalledMaps(e2e, [PUBLIC_MAP]);
    expect(linked).toContain(PUBLIC_MAP);

    const semantic = profileDir(e2e, "dev-assets", PUBLIC_MAP);
    const native = profileDir(e2e, ".corpus", PUBLIC_MAP);
    const receipt = await readReceipt(native, { name: PUBLIC_MAP, profile: "native" });
    const semanticReceipt = await readReceipt(semantic, { name: PUBLIC_MAP, profile: "semantic" });
    expect(semanticReceipt.releaseDigest).toBe(receipt.releaseDigest);
    expect(receipt.name).toBe(PUBLIC_MAP);
    // A real release is never the synthetic fixture closure.
    expect(receipt.canonicalDigest).not.toBe(closureDigest(canonicalClosure));

    // Every member the receipt claims is present with the digest it claims.
    const members = Object.entries(receipt.members);
    expect(members.length).toBeGreaterThan(0);
    for (const [memberPath, member] of members) {
      const path = join(native, ...memberPath.split("/"));
      expect(await stat(path).then((info) => info.size)).toBe(member.bytes);
      expect(await digestOfFile(path)).toBe(member.sha256);
    }

    // The catalog the product reads must show this map as a real derived map,
    // not a placeholder scene.
    const listed = await runCli(["maps", "list"], { ctx: e2e, expectExit: 0 });
    const catalog = listed.json as LocalCatalog;
    expect(resolve(catalog.devAssets)).toBe(resolve(semantic, ".."));
    const entry = catalog.maps.find((map) => map.mapId === PUBLIC_MAP);
    expect(entry, `${PUBLIC_MAP} is missing from the installed catalog`).toBeDefined();
    expect(entry!.artifacts).toMatchObject({ topologyIndex: true, derivedTopology: true, locations: true });
    expect(entry!.catalogRevision).toBeTruthy();
    expect(entry!.stats!.locations).toBeGreaterThan(0);
    expect(entry!.stats!.junctions + entry!.stats!.segments).toBeGreaterThan(0);

    await writeEvidence(testInfo, "maps-real-corpus", {
      mode: "real-map",
      map: PUBLIC_MAP,
      version: receipt.version,
      digests: {
        release: receipt.releaseDigest,
        canonicalClosure: receipt.canonicalDigest,
        webClosure: receipt.webDigest ?? null,
        matcherIndex: entry!.matcherIndexDigest,
        engineGraph: entry!.engineGraphDigest,
      },
      catalogRevision: entry!.catalogRevision,
      stats: entry!.stats,
      members: members.length,
    });
  });
});
