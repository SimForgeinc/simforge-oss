import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { isSimulationMapMember } from "@simforge-oss/compiler";
import { canonicalJson, serializeTemplate, simContentHash, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

import { ScenarioPackageExportError } from "./errors";

/**
 * The manifest draft and members of one scenario revision's
 * `simforge.scenario-package/v1` (docs/engineering/scenario-package.md), from
 * bytes and rows the host has already read. Pure: no database, no store, no
 * clock. The Rust `simforge-package` writer (through
 * `@simforge-oss/native-runtime`) then computes `members[]`, re-checks every
 * cross-digest and refuses anything its reader would refuse, so this module
 * never has to be the last word on validity; it only has to be exact about
 * where each field comes from.
 *
 * The worked example it follows is `Case::build()` in
 * native/crates/simforge-package/tests/support/mod.rs.
 */

export const SCENARIO_PACKAGE_SCHEMA = "simforge.scenario-package/v1";
export const SCENARIO_PACKAGE_MEDIA_TYPE = "application/vnd.simforge.scenario-package+zip";
export const BROWSER_ASSET_SET_CONTRACT = "uniscenario.browser-asset-set/v1";
export const ACTOR_CLOSURE_SCHEMA = "simforge.actor-assets-closure/v1";
export const ACTOR_CATALOG_PATH = "catalog-models.json";
export const EXECUTION_PACKAGE_CONTRACT = "uniscenario.execution-package/v1";
export const SCENARIO_PACKAGE_PRODUCER_APP = "simcloud";

/**
 * `producer.minCli`: the oldest `simforge` CLI that reads a package, per
 * contract dimension the package uses (PLAN §4.2). A package's `minCli` is
 * the highest entry over the dimensions it carries. The release agent bumps a
 * row only when that contract changes, and adds a row when a new version of
 * a dimension ships: a value with no row refuses the export
 * (`package_min_cli_unknown`) instead of guessing a CLI that may not read it.
 */
export const SCENARIO_PACKAGE_MIN_CLI: {
  readonly manifest: Readonly<Record<string, string>>;
  readonly scenarioVersion: Readonly<Record<number, string>>;
  readonly traceFormat: Readonly<Record<number, string>>;
  readonly samplerVersion: Readonly<Record<string, string>>;
} = Object.freeze({
  manifest: { [SCENARIO_PACKAGE_SCHEMA]: "0.2.0" },
  scenarioVersion: { 2: "0.2.0" },
  // The CLI's trace upgrader chain (simforge-core trace/upgrade.rs) reads v1, v3, v4 and v5.
  traceFormat: { 1: "0.2.0", 3: "0.2.0", 4: "0.2.0", 5: "0.2.0" },
  samplerVersion: {
    "simforge.timeline-sampler/1": "0.2.0",
    "simforge.timeline-sampler/2": "0.2.0",
    "simforge.timeline-sampler/3": "0.2.0",
  },
});

/** One member of a `uniscenario.browser-asset-set/v1` listing (`closure.ts` `planUploadedMapClosure`). */
export type MapClosureMember = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  role: "manifest" | "environment" | "geometry" | "texture" | "runtime" | "metadata";
  required: boolean;
};

export type ScenarioPackageSources = {
  revision: {
    id: string;
    documentId: string;
    revisionNumber: number;
    /** RFC 3339 UTC. */
    committedAt: string;
    title: string;
    content: unknown;
    /** `revisions.content_sha256`: the storage digest (`serializeTemplate`), not the canonical one. */
    storedContentSha256: string;
    assetCatalogVersionId: string | null;
    /** `revisions.map_closure_sha256` (`simforge.map-pin-closure/v1`) when the revision is pinned. */
    mapClosureSha256: string | null;
    /** `revisions.oss_release`: the stack release that cut the revision (and ran its original simulation). */
    ossRelease: string | null;
  };
  result: {
    simKey: string;
    traceSha256: string;
    authoredTraceSha256: string;
    traceGzipSha256: string;
    engineSemVer: string;
    solverVer: string;
    traceSchema: string;
    resolvedInputDigest: string;
    resolutionSha256: string;
    mapClosureDigest: string;
    mapVersionId: string;
    trafficProvider: string;
    trafficStepKey: string | null;
    engineBuild: Readonly<Record<string, unknown>>;
    producer: string;
    /** RFC 3339 UTC. */
    createdAt: string;
    ambientProvenance: unknown;
  };
  /** The stored `.trace.json.gz`, verbatim. */
  traceGzip: Uint8Array;
  /** The stored `simforge.sim-resolution/v1` record, verbatim. */
  resolutionGzip: Uint8Array;
  /** The result's materialized traffic artifact, verbatim, when it has one. */
  traffic: Uint8Array | null;
  /** The render timeline's canonical JSON, verbatim (sha256 = its `timelineSha256`). */
  timeline: Uint8Array;
  map: {
    mapVersionId: string;
    sourceMapId: string;
    label: string;
    xodrSha256: string;
    coordinateSystemSha256: string;
    /** `browser_asset_sets.closure_sha256` of the version's available asset set. */
    browserClosureSha256: string;
    members: readonly MapClosureMember[];
  };
  actors: {
    /** The pinned `simforge.actor-assets-closure/v1` document, verbatim. */
    closure: Uint8Array;
    /** Its `catalog-models.json` member, verified against the closure. */
    catalogModels: Uint8Array;
  };
  /** `galleryCatalogEntry` of every gallery id the document binds (the request key's `catalogEntries`). */
  catalogEntries: readonly unknown[];
  /** The revision's OpenSCENARIO export derived from this result (existing exporter), verbatim. */
  xosc: Uint8Array;
  sumo: { runtimeVersion: string; wasmSha256: string } | null;
  pipelineRevision: number;
  installation: { kind: "simcloud" | "local-studio"; id: string };
  /** Whether the packaged result is the revision's original simulation or a re-simulation of it. */
  motionSource: "original" | "resimulated";
  /** This exporter's release: `producer.appVersion` and `receipt.exporterRelease`. */
  appVersion: string;
};

export type ScenarioPackageBlobRef = { sha256: string; bytes: number; source: "map" | "actors"; path: string; role: string };

export type ComposedScenarioPackage = {
  manifest: Record<string, unknown>;
  members: { path: string; data: Uint8Array }[];
  title: string;
  summary: ScenarioPackageSummary;
  /** Blobs a full package embeds (scenario-package.md §8.1 rule 5 plus the texture choice), one entry per digest. */
  fullBlobs(options: { textures: boolean }): ScenarioPackageBlobRef[];
};

export type ScenarioPackageSummary = {
  title: string;
  revisionId: string;
  revisionNumber: number;
  committedAt: string;
  engineSemVer: string;
  traceFormat: number;
  samplerVersion: string;
  simulatedAt: string;
  minCli: string;
  motionSource: "original" | "resimulated";
  map: { mapVersionId: string; label: string; browserClosureSha256: string; memberCount: number; bytes: number; textureBytes: number };
  actors: { catalogIds: string[]; referencedBlobs: { count: number; bytes: number } };
};

function refuse(code: string, message: string, detail: Record<string, unknown> = {}, status = 409): never {
  throw new ScenarioPackageExportError(code, message, status, detail);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    return refuse("package_member_invalid", `${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`, {}, 500);
  }
}

/** `x.y.z` (the table has no pre-releases). */
function semverParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`minCli table entry ${version} is not x.y.z`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function maxSemver(versions: readonly string[]): string {
  return versions.reduce((best, next) => {
    const [a, b] = [semverParts(best), semverParts(next)];
    for (let i = 0; i < 3; i += 1) {
      if (b[i]! !== a[i]!) return b[i]! > a[i]! ? next : best;
    }
    return best;
  });
}

/** `producer.minCli` for the dimensions a package carries; see {@link SCENARIO_PACKAGE_MIN_CLI}. */
export function scenarioPackageMinCli(dimensions: {
  scenarioVersion: number;
  traceFormat: number;
  samplerVersions: readonly string[];
}): string {
  const table = SCENARIO_PACKAGE_MIN_CLI;
  const rows: [string, string | undefined][] = [
    [`manifest ${SCENARIO_PACKAGE_SCHEMA}`, table.manifest[SCENARIO_PACKAGE_SCHEMA]],
    [`scenarioVersion ${dimensions.scenarioVersion}`, table.scenarioVersion[dimensions.scenarioVersion]],
    [`traceFormat ${dimensions.traceFormat}`, table.traceFormat[dimensions.traceFormat]],
    ...dimensions.samplerVersions.map((s): [string, string | undefined] => [`samplerVersion ${s}`, table.samplerVersion[s]]),
  ];
  const missing = rows.filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) {
    refuse(
      "package_min_cli_unknown",
      `No simforge CLI version is recorded as reading ${missing.join(", ")}; add the row to SCENARIO_PACKAGE_MIN_CLI before exporting this contract.`,
      { dimensions: missing },
      500,
    );
  }
  return maxSemver(rows.map(([, v]) => v!));
}

/** `<title-slug>.<first 12 hex>.scenario.zip`, exactly as the crate's `file_name`. */
export function scenarioPackageFileName(title: string, packageId: string): string {
  return `${scenarioPackageSlug(title)}.${packageId.slice(0, 12)}.scenario.zip`;
}

export function scenarioPackageSlug(title: string): string {
  let slug = "";
  for (const c of title.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) slug += c;
    else if (!slug.endsWith("-") && slug.length > 0) slug += "-";
    if (slug.length >= 60) break;
  }
  slug = slug.replace(/-+$/, "");
  return slug || "scenario";
}

/** `pkg_<first 12 hex>`. */
export function scenarioPackageDisplayId(packageId: string): string {
  return `pkg_${packageId.slice(0, 12)}`;
}

/**
 * The copyable one-liner the export dialog shows: import the package into a
 * workspace directory named after it, then render that workspace. `rig.json`
 * is the user's sensor rig (`simforge render --rig`).
 */
export function scenarioPackageCliCommand(fileName: string): string {
  const workspace = fileName.replace(/\.scenario\.zip$/, "").split(".")[0] || "scenario";
  return `simforge package import ${fileName} --into ${workspace} && simforge render ${workspace} --preset training --rig rig.json --out ${workspace}-render`;
}

/** `simforge.map-pin-closure/v1` over the listing's simulation members, as the crate recomputes it. */
export function pinClosureSha256(members: readonly MapClosureMember[]): string {
  const lines = [...members]
    .filter((m) => isSimulationMapMember(m.relativePath))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))
    .map((m) => `${m.relativePath} ${m.sha256}\n`)
    .join("");
  return sha256Hex(lines);
}

/** The listing as `closure.ts` digests it: members sorted by path, canonical JSON. */
export function mapClosureListing(members: readonly MapClosureMember[]): Uint8Array {
  const sorted = [...members].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return utf8(canonicalJson({
    contractVersion: BROWSER_ASSET_SET_CONTRACT,
    members: sorted.map((m) => ({
      relativePath: m.relativePath,
      sha256: m.sha256,
      byteLength: m.byteLength,
      mediaType: m.mediaType,
      role: m.role,
      required: m.required,
    })),
  }));
}

type ActorClosureDocument = { schema: string; members: Record<string, { bytes: number; sha256: string }> };

export function parseActorClosure(bytes: Uint8Array): ActorClosureDocument {
  const doc = parseJson(bytes, "the actor closure") as Partial<ActorClosureDocument>;
  if (doc?.schema !== ACTOR_CLOSURE_SCHEMA || !doc.members || typeof doc.members !== "object" || Array.isArray(doc.members)) {
    return refuse("package_actor_closure_invalid", `the actor closure is not a ${ACTOR_CLOSURE_SCHEMA} document`, {}, 500);
  }
  if (!doc.members[ACTOR_CATALOG_PATH]) {
    return refuse("package_actor_closure_invalid", `the actor closure lists no ${ACTOR_CATALOG_PATH}`, {}, 500);
  }
  return doc as ActorClosureDocument;
}

/**
 * Closure paths `catalogIds` reach through `catalog-models.json`: the table
 * itself, each id's `model.glbPath` and every `animations.<motion>.glbPath`.
 * An id the table does not list is procedural and reaches nothing. The same
 * rule as the crate's `ActorClosure::reachable`.
 */
export function reachableActorPaths(closure: ActorClosureDocument, catalogModels: Uint8Array, catalogIds: readonly string[]): string[] {
  const raw = parseJson(catalogModels, ACTOR_CATALOG_PATH);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse("package_actor_closure_invalid", `${ACTOR_CATALOG_PATH} is not an object`, {}, 500);
  }
  const root = raw as Record<string, unknown>;
  const wrapped = ["models", "entries", "vehicles"]
    .map((k) => root[k])
    .find((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v));
  const table = wrapped ?? root;
  // Models the closure lists as `withheld` (no redistribution licence) are
  // refused by name, never treated as procedural (the crate's actor_model_withheld).
  const withheld = root.withheld && typeof root.withheld === "object" && !Array.isArray(root.withheld)
    ? Object.keys(root.withheld as Record<string, unknown>)
    : [];
  const bound = catalogIds.filter((id) => withheld.includes(id));
  if (bound.length > 0) {
    refuse(
      "package_actor_model_withheld",
      `the scenario binds actor model${bound.length === 1 ? "" : "s"} ${bound.join(", ")}, which the actor closure withholds (no redistribution licence); it cannot be exported for the CLI`,
      { catalogIds: bound },
    );
  }
  const out = new Set<string>([ACTOR_CATALOG_PATH]);
  const add = (id: string, what: string, path: unknown) => {
    if (typeof path !== "string") refuse("package_actor_closure_invalid", `${ACTOR_CATALOG_PATH}: ${id} ${what} has no glbPath`, {}, 500);
    if (!closure.members[path as string]) {
      refuse("package_actor_assets_missing", `${ACTOR_CATALOG_PATH} binds ${id} ${what} to ${String(path)}, which the actor closure does not list`, { catalogId: id }, 500);
    }
    out.add(path as string);
  };
  for (const id of catalogIds) {
    const entry = table[id];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      refuse("package_actor_closure_invalid", `${ACTOR_CATALOG_PATH}: entry ${id} is not an object`, {}, 500);
    }
    const record = entry as Record<string, unknown>;
    const model = record.model === undefined ? record : record.model;
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      refuse("package_actor_closure_invalid", `${ACTOR_CATALOG_PATH}: entry ${id} model is not an object`, {}, 500);
    }
    add(id, "model", (model as Record<string, unknown>).glbPath);
    if (record.animations !== undefined) {
      if (!record.animations || typeof record.animations !== "object" || Array.isArray(record.animations)) {
        refuse("package_actor_closure_invalid", `${ACTOR_CATALOG_PATH}: entry ${id} animations is not an object`, {}, 500);
      }
      for (const [name, clip] of Object.entries(record.animations as Record<string, unknown>)) {
        add(id, `animation ${name}`, (clip as Record<string, unknown> | null)?.glbPath);
      }
    }
  }
  return [...out].sort();
}

/** `sim_results.producer` → the manifest's `producerKind`. The raw string (host names) is never exported. */
export function producerKind(producer: string): "inline" | "runner" | "cli" | "editor" {
  if (producer.startsWith("inline:")) return "inline";
  if (producer.startsWith("cpu:") || producer.startsWith("runner:") || producer.startsWith("worker:")) return "runner";
  if (producer.startsWith("cli:")) return "cli";
  if (producer.startsWith("editor:") || producer.startsWith("browser:")) return "editor";
  return refuse(
    "package_producer_kind_unknown",
    `the simulation result was produced by an executor this exporter cannot classify (${producer.split(":")[0]}); add it to producerKind()`,
  );
}

function engineBuild(recorded: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Exactly the recorded ones of the five fields the manifest defines; anything
  // else in `sim_results.engine_build` is host detail the package does not carry.
  const out: Record<string, unknown> = {};
  if (typeof recorded.engineVersion === "string" && recorded.engineVersion) out.engineVersion = recorded.engineVersion;
  if (typeof recorded.abiVersion === "number" && Number.isInteger(recorded.abiVersion) && recorded.abiVersion >= 0) out.abiVersion = recorded.abiVersion;
  if (isHex64(recorded.buildDigest)) out.buildDigest = recorded.buildDigest;
  if (isHex64(recorded.addonSha256)) out.addonSha256 = recorded.addonSha256;
  if (typeof recorded.sourceRevision === "string" && recorded.sourceRevision) out.sourceRevision = recorded.sourceRevision;
  return out;
}

type TimelineDocument = {
  version?: string;
  identity?: { samplerVersion?: string; timelineKey?: string; traceSha256?: string; heightFieldDigest?: string; catalogDigest?: string | null };
  actors?: { catalogId?: string }[];
  props?: { catalogId?: string }[];
};

type TraceHeader = { traceVersion?: number; groundDigest?: string | null; engineGraphDigest?: string; inputHash?: string };

function traceHeader(traceGzip: Uint8Array): TraceHeader {
  let plain: Buffer;
  try {
    plain = gunzipSync(traceGzip);
  } catch (error) {
    return refuse("package_member_invalid", `the stored trace is not gzip: ${error instanceof Error ? error.message : String(error)}`, {}, 500);
  }
  const header = (parseJson(plain, "the stored trace") as { header?: TraceHeader }).header;
  if (!header || typeof header.traceVersion !== "number") {
    return refuse("package_member_invalid", "the stored trace has no header.traceVersion", {}, 500);
  }
  return header;
}

export function composeScenarioPackage(sources: ScenarioPackageSources): ComposedScenarioPackage {
  const { revision, result, map } = sources;

  // document.json: canonical JSON of the revision's content, which must be the
  // content the revision's own (storage-grid) digest names.
  const content = revision.content as ScenarioTemplateV2;
  if (sha256Hex(serializeTemplate(content)) !== revision.storedContentSha256) {
    refuse("package_document_digest_mismatch", `revision ${revision.id}'s stored content does not match its content_sha256`, {}, 500);
  }
  const document = utf8(canonicalJson(content));
  const scenarioVersion = (content as { scenarioVersion?: unknown }).scenarioVersion;
  if (typeof scenarioVersion !== "number" || !Number.isInteger(scenarioVersion)) {
    refuse("package_member_invalid", `revision ${revision.id}'s document has no integer scenarioVersion`, {}, 500);
  }

  // trace + resolution: the stored objects, byte for byte.
  if (sha256Hex(sources.traceGzip) !== result.traceGzipSha256) {
    refuse("package_digest_mismatch", `the stored trace of result ${result.simKey} does not match its recorded digest`, {}, 500);
  }
  if (sha256Hex(sources.resolutionGzip) !== result.resolutionSha256) {
    refuse("package_digest_mismatch", `the stored resolution record of result ${result.simKey} does not match its recorded digest`, {}, 500);
  }
  const header = traceHeader(sources.traceGzip);
  const traceFormat = header.traceVersion!;
  const traceSchema = `simforge.trace/v${traceFormat}`;
  if (result.traceSchema !== traceSchema) {
    refuse("package_identity_mismatch", `result ${result.simKey} records trace schema ${result.traceSchema}, its stored trace is ${traceSchema}`, {}, 500);
  }
  const groundDigest = typeof header.groundDigest === "string" ? header.groundDigest : null;

  // timeline: canonical bytes, keyed by their own digest.
  const timelineSha256 = sha256Hex(sources.timeline);
  const timeline = parseJson(sources.timeline, "the render timeline") as TimelineDocument;
  const identity = timeline.identity;
  if (!identity?.samplerVersion || !identity.timelineKey || !identity.heightFieldDigest || typeof timeline.version !== "string") {
    refuse("package_member_invalid", "the render timeline has no identity", {}, 500);
  }
  if (identity.traceSha256 !== result.traceSha256) {
    refuse("package_identity_mismatch", `the render timeline was sampled from trace ${String(identity.traceSha256)}, not ${result.traceSha256}`, {}, 500);
  }
  const catalogIds = [...new Set([...(timeline.actors ?? []), ...(timeline.props ?? [])].map((a) => a.catalogId))]
    .filter((id): id is string => typeof id === "string")
    .sort();

  // map/closure.json: the version's listing, which must digest to the asset set's recorded closure.
  const mapListing = mapClosureListing(map.members);
  if (sha256Hex(mapListing) !== map.browserClosureSha256) {
    refuse(
      "package_map_closure_mismatch",
      `map version ${map.mapVersionId}'s browser asset members do not digest to its recorded closure ${map.browserClosureSha256.slice(0, 12)}`,
      { mapVersionId: map.mapVersionId },
      500,
    );
  }
  const pin = pinClosureSha256(map.members);
  if (revision.mapClosureSha256 && revision.mapClosureSha256 !== pin) {
    refuse(
      "package_identity_mismatch",
      `revision ${revision.id} is pinned to map closure ${revision.mapClosureSha256.slice(0, 12)}, its map version's simulation members digest to ${pin.slice(0, 12)}`,
      {},
      500,
    );
  }
  const mapBytes = map.members.reduce((sum, m) => sum + m.byteLength, 0);
  const textureBytes = map.members.filter((m) => m.role === "texture").reduce((sum, m) => sum + m.byteLength, 0);

  // actors/closure.json + the blobs catalogIds reach.
  const actorClosure = parseActorClosure(sources.actors.closure);
  const catalogEntry = actorClosure.members[ACTOR_CATALOG_PATH]!;
  if (sha256Hex(sources.actors.catalogModels) !== catalogEntry.sha256 || sources.actors.catalogModels.byteLength !== catalogEntry.bytes) {
    refuse("package_digest_mismatch", `${ACTOR_CATALOG_PATH} does not match the actor closure's listing`, {}, 500);
  }
  const reachable = reachableActorPaths(actorClosure, sources.actors.catalogModels, catalogIds);
  const distinct = new Map(reachable.map((p) => [actorClosure.members[p]!.sha256, actorClosure.members[p]!.bytes]));
  const referencedActorBlobs = { count: distinct.size, bytes: [...distinct.values()].reduce((a, b) => a + b, 0) };

  const catalogBytes = utf8(canonicalJson(sources.catalogEntries));
  const samplerVersion = identity!.samplerVersion!;
  const minCli = scenarioPackageMinCli({ scenarioVersion: scenarioVersion as number, traceFormat, samplerVersions: [samplerVersion] });

  const title = revision.title.trim() || "Untitled scenario";
  const release = revision.ossRelease ?? sources.appVersion;
  const manifest: Record<string, unknown> = {
    schema: SCENARIO_PACKAGE_SCHEMA,
    producer: { app: SCENARIO_PACKAGE_PRODUCER_APP, appVersion: sources.appVersion, minCli },
    scenario: {
      title,
      documentSchema: `simforge.scenario.v${scenarioVersion as number}`,
      scenarioVersion,
      contentSha256: sha256Hex(document),
      simContentSha256: simContentHash(content),
      origin: {
        documentId: revision.documentId,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        committedAt: revision.committedAt,
      },
    },
    engine: {
      engineSemVer: result.engineSemVer,
      solverVersion: result.solverVer,
      pipelineRevision: sources.pipelineRevision,
      build: engineBuild(result.engineBuild),
      release,
    },
    simulation: {
      simKey: result.simKey,
      traceFormat,
      traceSchema,
      traceSha256: result.traceSha256,
      traceGzipSha256: result.traceGzipSha256,
      authoredTraceSha256: result.authoredTraceSha256,
      resolvedInputDigest: result.resolvedInputDigest,
      resolutionSha256: result.resolutionSha256,
      trafficProvider: result.trafficProvider,
      trafficStepKey: result.trafficStepKey,
      trafficSha256: sources.traffic ? sha256Hex(sources.traffic) : null,
      sumo: sources.sumo
        ? { networkSha256: sumoNetwork(result.ambientProvenance), runtimeVersion: sources.sumo.runtimeVersion, wasmSha256: sources.sumo.wasmSha256 }
        : null,
      groundDigest,
      producerKind: producerKind(result.producer),
      simulatedAt: result.createdAt,
    },
    timelines: [{
      version: timeline.version,
      samplerVersion,
      timelineKey: identity!.timelineKey,
      timelineSha256,
      heightFieldDigest: identity!.heightFieldDigest,
      catalogDigest: identity!.catalogDigest ?? null,
    }],
    executionPackage: { contract: EXECUTION_PACKAGE_CONTRACT, xoscSha256: sha256Hex(sources.xosc) },
    map: {
      mapVersionId: map.mapVersionId,
      sourceMapId: map.sourceMapId,
      label: map.label,
      xodrSha256: map.xodrSha256,
      coordinateSystemSha256: map.coordinateSystemSha256,
      mapClosureDigest: result.mapClosureDigest,
      pinClosureSha256: pin,
      browserClosureSha256: map.browserClosureSha256,
      heightSourceDigest: identity!.heightFieldDigest,
      groundDigest,
      closure: { memberCount: map.members.length, bytes: mapBytes },
    },
    catalog: {
      assetCatalogVersionId: revision.assetCatalogVersionId,
      catalogSha256: sha256Hex(catalogBytes),
      actorClosureDigest: sha256Hex(sources.actors.closure),
      actorClosureSchema: ACTOR_CLOSURE_SCHEMA,
      catalogIds,
      referencedActorBlobs,
    },
    render: null,
    provenance: { installationKind: sources.installation.kind, installationId: sources.installation.id, authorDisplayName: null },
    extensions: {
      // Where `engine.release` came from: the revision's recorded release, or
      // (revisions cut before it was recorded) this exporter's, stated rather than implied.
      "simcloud.releaseSource": revision.ossRelease ? "revision" : "exporter",
      // The package always holds the revision's original result when it has one.
      "simcloud.motionSource": sources.motionSource,
    },
  };

  const members: { path: string; data: Uint8Array }[] = [
    { path: "document.json", data: document },
    { path: "simulation/trace.json.gz", data: sources.traceGzip },
    { path: "simulation/resolution.json.gz", data: sources.resolutionGzip },
    ...(sources.traffic ? [{ path: "simulation/materialized-traffic.json", data: sources.traffic }] : []),
    { path: `timeline/${timelineSha256}.json`, data: sources.timeline },
    { path: "map/closure.json", data: mapListing },
    { path: "actors/closure.json", data: sources.actors.closure },
    { path: "catalog/entries.json", data: catalogBytes },
    { path: "export/scenario.xosc", data: sources.xosc },
  ];

  const summary: ScenarioPackageSummary = {
    title,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    committedAt: revision.committedAt,
    engineSemVer: result.engineSemVer,
    traceFormat,
    samplerVersion,
    simulatedAt: result.createdAt,
    minCli,
    motionSource: sources.motionSource,
    map: {
      mapVersionId: map.mapVersionId,
      label: map.label,
      browserClosureSha256: map.browserClosureSha256,
      memberCount: map.members.length,
      bytes: mapBytes,
      textureBytes,
    },
    actors: { catalogIds, referencedBlobs: referencedActorBlobs },
  };

  return {
    manifest,
    members,
    title,
    summary,
    fullBlobs({ textures }) {
      const blobs = new Map<string, ScenarioPackageBlobRef>();
      for (const m of map.members) {
        if (m.role === "texture" && !textures) continue;
        if (!blobs.has(m.sha256)) blobs.set(m.sha256, { sha256: m.sha256, bytes: m.byteLength, source: "map", path: m.relativePath, role: m.role });
      }
      for (const p of reachable) {
        const a = actorClosure.members[p]!;
        if (!blobs.has(a.sha256)) blobs.set(a.sha256, { sha256: a.sha256, bytes: a.bytes, source: "actors", path: p, role: "actor" });
      }
      return [...blobs.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
    },
  };
}

function sumoNetwork(ambient: unknown): string {
  const network = (ambient as { mode?: string; networkSha256?: unknown } | null)?.networkSha256;
  if ((ambient as { mode?: string } | null)?.mode !== "sumo" || !isHex64(network)) {
    return refuse("package_sumo_provenance_missing", "a SUMO result without a recorded SUMO network digest cannot be packaged", {}, 500);
  }
  return network;
}
